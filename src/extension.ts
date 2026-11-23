/**
 * Extension Entry Point – VS Code host integration for `corex lsp` and `corex fmt`.
 *
 * Activates lazily on `.cx` documents or `corex.toml` workspaces, gates all binary execution
 * behind `workspace.isTrusted`, synchronizes `file:` buffers, maps LSP 3.17 features onto the
 * VS Code host API, and supervises server restarts.
 *
 * Enforces bounded caches, `75 ms` watcher debouncing, and `<= 4` crash restarts per `60 s`.
 */

import {
  CodeAction,
  CodeActionKind,
  commands,
  CompletionItem,
  CompletionList,
  Diagnostic,
  DiagnosticRelatedInformation,
  DocumentHighlight,
  DocumentSymbol,
  EventEmitter,
  Hover,
  InlayHint,
  languages,
  Location,
  MarkdownString,
  ParameterInformation,
  Position,
  Range,
  SemanticTokens,
  SemanticTokensEdit,
  SemanticTokensEdits,
  SemanticTokensLegend,
  SignatureHelp,
  SignatureInformation,
  SymbolInformation,
  TextEdit,
  ThemeColor,
  Uri,
  WorkspaceEdit,
} from 'vscode';
import type {
  CancellationToken,
  CompletionItemKind,
  CompletionItemTag,
  DiagnosticCollection,
  DiagnosticSeverity,
  DiagnosticTag,
  Disposable,
  DocumentHighlightKind,
  DocumentSelector,
  EndOfLine,
  ExtensionContext,
  InlayHintKind,
  QuickPickItem,
  QuickPickItemKind,
  ReferenceContext,
  StatusBarAlignment,
  StatusBarItem,
  SymbolKind,
  SymbolTag,
  TextDocument,
} from 'vscode';
import { isInternalCoreEnabled, pathDirname, resolveCorexBinary } from '@/binary';
import {
  assignProps,
  clearTimer,
  computeMinimalUtf16Edit,
  hasArrayProp,
  INTERNAL_CORE_FLAG,
  isArray,
  isCanceled,
  isJsonRpcRequestError,
  isRecord,
  isStr,
  isValidUri,
  LSP_REQUEST_CANCELED,
  LSP_SERVER_CANCELED,
  notifyTextDocument,
  runCorexFmtCli,
  setTimer,
  startLspClient,
  TEXT_DOC_PREFIX,
} from '@/client';
import {
  COREX_CONFIG_SECTION,
  EXEC_PATH_KEY,
  hasServerRestartConfigChange,
  INLAY_HINTS_KEY,
  invalidateConfigCache,
  readExtensionConfig,
} from '@/config';
import type {
  BinaryResolutionMissing,
  ExtensionConfig,
  LspClientSession,
  LspCodeAction,
  LspCompletionItem,
  LspDiagnostic,
  LspDocumentHighlight,
  LspDocumentSymbol,
  LspFileChangeType,
  LspFileEvent,
  LspInlayHint,
  LspLocation,
  LspPosition,
  LspPublishDiagnosticsParams,
  LspRange,
  LspSemanticTokensEdit,
  LspSignatureInformation,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceFolder,
} from '@/types';
import {
  disposeLogger,
  logError,
  logInfo,
  logTrace,
  logWarn,
  showOutputChannel,
  vsWindow,
  vsWorkspace,
} from '@/utils/logger';

// ---------------------------------------- TYPES ----------------------------------------

/** Status-bar Codicon identifier (`check`, `sync~spin`, `warning`, `error`, `circle-slash`). */
type StatusIcon = 'check' | 'circle-slash' | 'error' | 'sync~spin' | 'warning';

/** Error handling policy for `requestLsp` (`0 = swallow`, `1 = Busy on -32802`, `2 = rethrow RPC`). */
type QueryErrorMode = 0 | 1 | 2;

/** Interactive item inside the CoreX status-bar QuickPick menu (`corex.showStatusMenu`). */
interface StatusMenuEntry extends QuickPickItem {
  /** Callback invoked when the user selects this menu entry. */
  readonly action?: () => unknown;
}

// --------------------------------------- CONSTS ----------------------------------------

/** Local alias binding `languages` to a mangleable identifier. */
const vsLanguages = languages;

/** Local alias binding `TextEdit` to a mangleable identifier. */
const VsTextEdit = TextEdit;

/** Local alias binding `MarkdownString` to a mangleable identifier. */
const VsMarkdown = MarkdownString;

/** Shared `'Language Server'` title fragment. */
const LANG_SERVER_TEXT = 'Language Server';

/** Shared display label for the Language Server service. */
const LSP_SERVICE_LABEL = `${LANG_SERVER_TEXT} (\`corex lsp\`)`;

/** Shared display label for the Formatter service. */
const FMT_SERVICE_LABEL = 'Formatter (`corex fmt`)';

/** Command suffix revealing the `CoreX` output channel. */
const SUB_OUTPUT = 'showOutputChannel';

/** Command suffix restarting `corex lsp`. */
const SUB_RESTART = 'restartServer';

/** Command suffix stopping `corex lsp`. */
const SUB_STOP = 'stopServer';

/** Command suffix opening the status-bar QuickPick menu. */
const SUB_STATUS = 'showStatusMenu';

/** Command suffix toggling editor inlay hints. */
const SUB_HINTS = 'toggleInlayHints';

/** Local alias binding `CodeActionKind.QuickFix`. */
const QUICK_FIX_KIND = CodeActionKind.QuickFix;

/** Document selector matching local `file:` CoreX documents (`untitled:` excluded). */
const COREX_SELECTOR: DocumentSelector = { language: COREX_CONFIG_SECTION, scheme: 'file' };

/** Built-in VS Code command opening Settings filtered by query. */
const CMD_OPEN_SETTINGS = 'workbench.action.openSettings';

/** Shared warning string when no `corex` binary was auto-discovered. */
const BINARY_NOT_FOUND_MSG = 'CoreX: binary not found.';

/** $O(1)$ set of directory names ignored by workspace `FileSystemWatcher` callbacks. */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set(
  '.corex,.git,build,node_modules,zig-out'.split(',')
);

// ----------------------------------- REGEX PATTERNS ------------------------------------

/** Matches POSIX and Windows path separators without backtracking. */
const PATH_SPLIT_RX = /[\\/]/;

// -------------------------------------- INTERNALS --------------------------------------

// ----------------------- Session State ------------------------

/** Active `corex lsp` session set strictly after its initial `didOpen` sweep completes. */
let activeClient: LspClientSession | undefined = undefined;

/** Promise resolving to the ready `LspClientSession` for the current startup generation. */
let sessionPromise: Promise<LspClientSession | undefined> = Promise.resolve(undefined);

/** VS Code Problems panel collection for `corex` diagnostics. */
let diagnosticCollection: DiagnosticCollection | undefined = undefined;

/** Event emitter refreshing editor inlay hints on config or server changes. */
let inlayHintsEmitter: EventEmitter<void> | undefined = undefined;

/** Lazily created status-bar item (`CoreX`). */
let statusBarItem: StatusBarItem | undefined = undefined;

/** Timer scheduling a delayed server restart after an unexpected crash. */
let crashTimer: ReturnType<typeof setTimeout> | undefined = undefined;

/** Debounce timer (`75 ms`) coalescing `FileSystemWatcher` events. */
let watcherTimer: ReturnType<typeof setTimeout> | undefined = undefined;

/** Last binary-missing key surfaced as a toast notification to avoid repeat spam. */
let lastMissingKey: string | undefined = undefined;

/** Last status-bar icon and summary headline used to refresh dynamic config toggles. */
let lastStatusState: readonly [StatusIcon, string] | undefined = undefined;

/** Whether `corex lsp` was explicitly stopped via `CoreX: Stop Language Server`. */
let isManuallyStopped = false;

/** Whether the extension is currently deactivated. */
let isDeactivated = false;

/** Monotonic generation counter invalidating stale async startup operations. */
let sessionGen = 0;

/** Canonical `doc.uri.toString()` -> latest `doc.version` map of open `file:` `.cx` documents. */
const openDocVersions = new Map<string, number>();

/** Bounded LRU map (`<= 512`) of `previousResultId` tokens for `textDocument/diagnostic`. */
const pullResultIds = new Map<string, string>();

/** Coalesced watched file events awaiting the `75 ms` debounce flush. */
const pendingWatchedEvents = new Map<string, LspFileChangeType>();

/** Subscriptions for LSP-backed language feature providers. */
const lspProviderSubs: Disposable[] = [];

/** Subscriptions for document and range formatting providers. */
const formatProviderSubs: Disposable[] = [];

/** Epoch-millisecond timestamps of unexpected server exits within `CRASH_WINDOW_DURATION`. */
const crashTimestamps: number[] = [];

/**
 * Formats a `corex.<suffix>` identifier.
 *
 * @param suffix   Command or configuration key suffix.
 */
function corexId(suffix: string): string {
  return `${COREX_CONFIG_SECTION}.${suffix}`;
}

/**
 * Executes a VS Code command with an optional single string argument.
 *
 * @param commandId    Command identifier to invoke.
 * @param commandArg   Optional string argument.
 */
function execVsCmd(commandId: string, commandArg?: string): Thenable<unknown> {
  return commands.executeCommand(commandId, ...(commandArg ? [commandArg] : []));
}

/**
 * Parses `rawUri` into a VS Code `Uri` instance.
 *
 * @param rawUri   Canonical URI string.
 */
function parseVsUri(rawUri: string): Uri {
  return Uri.parse(rawUri);
}

/**
 * Serializes `holder.uri` into its canonical URI string.
 *
 * @param holder   Document or workspace folder carrying `.uri`.
 */
function readDocUri(holder: { readonly uri: Uri }): string {
  return holder.uri.toString();
}

/**
 * Swallows background promise rejections already handled by internal logging.
 *
 * @param promise   Fire-and-forget async operation.
 */
function runDetached(promise: PromiseLike<unknown>): void {
  promise.then(undefined, () => undefined);
}

/**
 * Disposes and clears a mutable array of `Disposable` subscriptions.
 *
 * @param subs   Subscription list to drain.
 */
function disposeList(subs: Disposable[]): void {
  for (const sub of subs) {
    sub.dispose();
  }
  subs.length = 0;
}

/** Returns `true` when the workspace is trusted and `corex.enable` is `true`. */
function isCorexActive(): boolean {
  return vsWorkspace.isTrusted && readExtensionConfig().isEnabled;
}

/** Returns `activeClient` when its `didOpen` sweep completed and the process is running. */
function getRunningClient(): LspClientSession | undefined {
  return activeClient?.isRunning() ? activeClient : undefined;
}

/**
 * Returns `true` when `document` is a local `file:` CoreX source document within URI byte limits.
 *
 * @param document   VS Code `TextDocument` to check.
 */
function isCorexFileDoc(document: TextDocument): boolean {
  return (
    document.languageId === COREX_CONFIG_SECTION &&
    document.uri.scheme === 'file' &&
    isValidUri(readDocUri(document))
  );
}

/**
 * Visits every currently open local `file:` CoreX `TextDocument`.
 *
 * @param visitor   Callback invoked for each matching document.
 */
function forEachOpenCxDoc(visitor: (document: TextDocument) => void): void {
  for (const doc of vsWorkspace.textDocuments) {
    if (isCorexFileDoc(doc)) {
      visitor(doc);
    }
  }
}

/**
 * Runs `handler` when `activeClient` is ready and `document` is a valid `file:` CoreX document.
 *
 * @param document   Candidate document.
 * @param handler    Callback receiving `(client, canonicalUri)`.
 */
function withRunningDoc(
  document: TextDocument,
  handler: (client: LspClientSession, uri: string) => void
): void {
  const client = getRunningClient();
  if (client !== undefined && isCorexFileDoc(document)) {
    handler(client, readDocUri(document));
  }
}

/**
 * Returns `true` when `fsPath` contains any directory segment listed in `IGNORED_SEGMENTS`.
 *
 * @param fsPath   Filesystem path emitted by `FileSystemWatcher`.
 */
function hasIgnoredSegment(fsPath: string): boolean {
  for (const segment of fsPath.split(PATH_SPLIT_RX)) {
    if (IGNORED_SEGMENTS.has(segment)) {
      return true;
    }
  }
  return false;
}

/** Collects filesystem paths and LSP descriptors of all open local `file:` workspace folders. */
function collectWorkspaces(): readonly [string[], LspWorkspaceFolder[]] {
  const dirs: string[] = [];
  const lspFolders: LspWorkspaceFolder[] = [];
  for (const folder of vsWorkspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file') {
      dirs.push(folder.uri.fsPath);
      lspFolders.push({ name: folder.name, uri: readDocUri(folder) });
    }
  }
  return [dirs, lspFolders];
}

/**
 * Inserts or updates `(uri, value)` in `cache`, evicting the oldest entry above `512`.
 *
 * @param cache   Bounded LRU map.
 * @param uri     Canonical document URI key.
 * @param value   Cached value.
 */
function putBounded<T>(cache: Map<string, T>, uri: string, value: T): void {
  if (!cache.delete(uri) && cache.size >= 512) {
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(uri, value);
}

/**
 * Maps a non-null array via an explicit indexed loop without intermediate closures.
 *
 * @param items    Source array.
 * @param mapper   Element conversion function.
 */
function mapList<T, R>(items: readonly T[], mapper: (item: T, index: number) => R): R[] {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += 1) {
    out.push(mapper(items[i] as T, i));
  }
  return out;
}

/**
 * Wraps an element mapper into an untrusted array validator returning `R[] | null`.
 *
 * @param mapper   Element conversion callback.
 */
function buildListMapper<T, R>(
  mapper: (item: T, index: number) => R
): (rawValue: unknown) => R[] | null {
  return (rawValue) => (isArray(rawValue) ? mapList(rawValue as readonly T[], mapper) : null);
}

/**
 * Summarizes `[client, lspStatus, fmtStatus, hintsStatus]` for the status-bar hover card and QuickPick menu.
 *
 * @param summary   Primary status headline.
 */
function describeServices(
  summary = 'Inactive'
): readonly [LspClientSession | undefined, string, string, string] {
  const cfg = readExtensionConfig();
  const client = getRunningClient();
  let lspStatus = summary;
  if (!vsWorkspace.isTrusted) {
    lspStatus = 'Untrusted';
  } else if (client) {
    lspStatus = `Running (\`pid ${client.pid}\`)`;
  } else if (isManuallyStopped) {
    lspStatus = 'Stopped';
  } else if (!cfg.isLspEnabled) {
    lspStatus = 'Disabled';
  }

  let fmtStatus = 'Disabled';
  if (isCorexActive() && cfg.isFormatEnabled) {
    fmtStatus = `Ready (${client ? 'LSP' : 'CLI'})`;
  }
  return [client, lspStatus, fmtStatus, cfg.isInlayHintsEnabled ? 'On' : 'Off'];
}

/**
 * Updates (and lazily creates) the `CoreX` status-bar indicator using monochrome Codicons.
 *
 * @param icon      Codicon identifier (`'check'`, `'sync~spin'`, `'warning'`, `'error'`, `'circle-slash'`).
 * @param summary   Concise status headline included in the dual-service hover tooltip.
 */
function setStatus(icon: StatusIcon, summary: string): void {
  if (isDeactivated) {
    return;
  }
  lastStatusState = [icon, summary];
  const [client, lspStatus, fmtStatus, hintsStatus] = describeServices(summary);
  const actionLinks = mapList(
    [
      ['Output', corexId(SUB_OUTPUT)],
      ['Restart', corexId(SUB_RESTART)],
      [client ? 'Stop' : 'Start', corexId(client ? SUB_STOP : SUB_RESTART)],
      [`Inlay Hints: ${hintsStatus}`, corexId(SUB_HINTS)],
      ['Settings', `${CMD_OPEN_SETTINGS}?%22${COREX_CONFIG_SECTION}%22`],
    ] as const,
    ([label, cmdTarget]) => `[${label}](command:${cmdTarget})`
  ).join(' · ');
  const tooltip = new VsMarkdown(
    `**CoreX** – ${summary}\n\n$(${client ? 'check' : icon}) **${LSP_SERVICE_LABEL}:** ${lspStatus}\n\n$(${fmtStatus === 'Disabled' ? 'circle-slash' : 'check'}) **${FMT_SERVICE_LABEL}:** ${fmtStatus}\n\n${actionLinks}`,
    true
  );
  tooltip.isTrusted = true;
  assignProps((statusBarItem ??= vsWindow.createStatusBarItem(2 as StatusBarAlignment, 100)), {
    backgroundColor:
      icon === 'error' || icon === 'warning'
        ? new ThemeColor(`statusBarItem.${icon}Background`)
        : undefined,
    command: corexId(SUB_STATUS),
    text: `$(${icon}) CoreX`,
    tooltip,
  }).show();
}

// ------------------------ Type Mappers ------------------------

/**
 * Coerces an untrusted numeric field into a clamped non-negative integer (`0` on `NaN`).
 *
 * @param rawNum   Untrusted numeric coordinate or index.
 */
function toNonNegInt(rawNum: unknown): number {
  return Math.max(0, Math.trunc(rawNum as number) || 0);
}

/**
 * Shifts a 1-based LSP enum value (`1..maxZero + 1`) to a clamped 0-based VS Code enum (`0..maxZero`).
 *
 * @param oneBased   1-based LSP integer discriminant.
 * @param maxZero    Maximum valid 0-based target discriminant.
 */
function shiftEnum(oneBased: number, maxZero: number): number {
  return Math.min(maxZero, toNonNegInt(oneBased - 1));
}

/**
 * Converts a `Position` to a 0-based `LspPosition`.
 *
 * @param position   VS Code UTF-16 position.
 */
function toLspPos(position: Position): LspPosition {
  return { character: position.character, line: position.line };
}

/**
 * Converts a `Range` to a 0-based `LspRange`.
 *
 * @param range   VS Code UTF-16 range.
 */
function toLspRange(range: Range): LspRange {
  return { end: toLspPos(range.end), start: toLspPos(range.start) };
}

/**
 * Wraps `range` into `{ range: LspRange }` for range-scoped LSP requests and edits.
 *
 * @param range   VS Code UTF-16 range.
 */
function toRangeParam(range: Range): { readonly range: LspRange } {
  return { range: toLspRange(range) };
}

/**
 * Converts an `LspPosition` into a clamped non-negative VS Code `Position`.
 *
 * @param position   0-based LSP position.
 */
function toVsPos(position?: Partial<LspPosition>): Position {
  return new Position(toNonNegInt(position?.line), toNonNegInt(position?.character));
}

/**
 * Converts an `LspRange` into a `Range`.
 *
 * @param range   0-based LSP range.
 */
function toVsRange(range?: Partial<LspRange>): Range {
  return new Range(toVsPos(range?.start), toVsPos(range?.end));
}

/**
 * Converts an untrusted `LspRange` object into a `Range | undefined`.
 *
 * @param rawRange   Untrusted range field.
 */
function tryVsRange(rawRange: unknown): Range | undefined {
  return isRecord(rawRange) && isRecord(rawRange.start) && isRecord(rawRange.end)
    ? toVsRange(rawRange as unknown as LspRange)
    : undefined;
}

/**
 * Converts an `LspLocation` into a VS Code `Location`.
 *
 * @param location   Cross-file target location.
 */
function toVsLocation(location: LspLocation): Location {
  return new Location(
    parseVsUri(isValidUri(location.uri) ? location.uri : 'file:///'),
    toVsRange(location.range)
  );
}

/**
 * Converts a single `LspTextEdit` into a VS Code `TextEdit`.
 *
 * @param edit   LSP text edit record.
 */
function toVsEdit(edit: LspTextEdit): TextEdit {
  return new VsTextEdit(toVsRange(edit.range), isStr(edit.newText) ? edit.newText : '');
}

/**
 * Appends `TextEdit.setEndOfLine(EndOfLine.LF)` when `edits` is non-empty and `document.eol === EndOfLine.CRLF`.
 *
 * @param document   Formatted document.
 * @param edits      Converted text edits.
 */
function appendLfEdit(document: TextDocument, edits: TextEdit[]): TextEdit[] {
  if (edits.length > 0 && (document.eol as number) === 2) {
    edits.push(VsTextEdit.setEndOfLine(1 as EndOfLine));
  }
  return edits;
}

/**
 * Narrows `rawVal` to `string | undefined`.
 *
 * @param rawVal   Untrusted string field.
 */
function readOptStr(rawVal: unknown): string | undefined {
  return isStr(rawVal) ? rawVal : undefined;
}

/**
 * Converts an untrusted semantic tokens response into `SemanticTokens | null`.
 *
 * @param rawValue   Untrusted LSP semantic tokens payload.
 */
function mapSemTokens(rawValue: unknown): SemanticTokens | null {
  return hasArrayProp(rawValue, 'data')
    ? new SemanticTokens(
        new Uint32Array(rawValue.data as readonly number[]),
        readOptStr(rawValue.resultId)
      )
    : null;
}

/**
 * Filters numeric LSP tags inside `[1, maxTag]` using an explicit loop.
 *
 * @param tags     Numeric tag array from LSP wire payload.
 * @param maxTag   Maximum valid 1-based tag (`1 = Deprecated`, `2 = DiagnosticTag.Deprecated`).
 */
function pickTags<T extends number>(
  tags: readonly number[] | undefined,
  maxTag = 1
): T[] | undefined {
  const valid: T[] = [];
  for (const tag of tags ?? []) {
    if (tag === 1 || tag === maxTag) {
      valid.push(tag as T);
    }
  }
  return valid[0] ? valid : undefined;
}

/**
 * Converts a slice of `LspDiagnostic` items into `Diagnostic[]`.
 *
 * @param items   LSP diagnostics for a single document.
 */
function toVsDiagnostics(items: readonly LspDiagnostic[]): Diagnostic[] {
  return mapList(items, (lspDiag) =>
    assignProps(
      new Diagnostic(
        toVsRange(lspDiag.range),
        lspDiag.message,
        shiftEnum(lspDiag.severity ?? 1, 3) as DiagnosticSeverity
      ),
      {
        code: lspDiag.code,
        relatedInformation:
          lspDiag.relatedInformation &&
          mapList(
            lspDiag.relatedInformation,
            (relInfo) =>
              new DiagnosticRelatedInformation(toVsLocation(relInfo.location), relInfo.message)
          ),
        source: lspDiag.source ?? COREX_CONFIG_SECTION,
        tags: pickTags<DiagnosticTag>(lspDiag.tags, 2),
      }
    )
  );
}

/** Shared validator mapping an untrusted `LspTextEdit[]` array into `TextEdit[] | null`. */
const mapEditList = buildListMapper(toVsEdit);

/** Shared validator mapping an untrusted `LspLocation[]` array into `Location[] | null`. */
const mapLocationList = buildListMapper(toVsLocation);

/**
 * Narrows and converts an untrusted `definition` / `typeDefinition` payload.
 *
 * @param rawValue   Untrusted location payload.
 */
function mapLocations(rawValue: unknown): Location | Location[] | null {
  return (
    mapLocationList(rawValue) ??
    (isRecord(rawValue) && isValidUri(rawValue.uri)
      ? toVsLocation(rawValue as unknown as LspLocation)
      : null)
  );
}

/**
 * Recursively converts an `LspDocumentSymbol` tree into a `DocumentSymbol` tree.
 *
 * @param rawSym   Hierarchical LSP document symbol node.
 */
function toVsDocSymbol(rawSym: LspDocumentSymbol): DocumentSymbol {
  return assignProps(
    new DocumentSymbol(
      rawSym.name,
      rawSym.detail ?? '',
      shiftEnum(rawSym.kind, 25) as SymbolKind,
      toVsRange(rawSym.range),
      toVsRange(rawSym.selectionRange)
    ),
    {
      ...(rawSym.children?.length && { children: mapList(rawSym.children, toVsDocSymbol) }),
      tags: pickTags<SymbolTag>(rawSym.tags),
    }
  );
}

/** Shared validator mapping an untrusted `LspDocumentSymbol[]` array into `DocumentSymbol[] | null`. */
const mapDocSymbolList = buildListMapper(toVsDocSymbol);

/**
 * Narrows `string | LspMarkupContent` into `string | MarkdownString | undefined`.
 *
 * @param docVal   Untrusted documentation block.
 */
function toVsDoc(docVal: unknown): string | MarkdownString | undefined {
  if (isStr(docVal)) {
    return docVal;
  } else if (isRecord(docVal) && isStr(docVal.value)) {
    return docVal.kind === 'markdown' ? new VsMarkdown(docVal.value) : docVal.value;
  }
  return undefined;
}

/**
 * Validates and converts an untrusted `LspWorkspaceEdit` into a `WorkspaceEdit | null`.
 *
 * @param rawEdit   Untrusted workspace edit object.
 */
function toVsWorkspaceEdit(rawEdit: unknown): WorkspaceEdit | null {
  if (!isRecord(rawEdit) || (rawEdit.changes !== undefined && !isRecord(rawEdit.changes))) {
    return null;
  }
  const edit = new WorkspaceEdit();
  for (const [uri, rawEdits] of Object.entries(rawEdit.changes ?? {})) {
    const mappedEdits = isValidUri(uri) && mapEditList(rawEdits);
    if (mappedEdits) {
      edit.set(parseVsUri(uri), mappedEdits);
    }
  }
  return edit;
}

// --------------------- Diagnostics & Sync ---------------------

/**
 * Records `document` in `openDocVersions` and sends `textDocument/didOpen`.
 *
 * @param client     Active `LspClientSession`.
 * @param document   Open `file:` CoreX document.
 * @param uri        Canonical `document.uri.toString()`.
 */
function syncOpenedDoc(
  client: LspClientSession,
  document: TextDocument,
  uri = readDocUri(document)
): void {
  if (
    notifyTextDocument(client, 'didOpen', uri, {
      languageId: COREX_CONFIG_SECTION,
      text: document.getText(),
      version: document.version,
    })
  ) {
    openDocVersions.set(uri, document.version);
  }
}

/**
 * Removes `document` from open/pull caches, clears its diagnostics, and notifies `didClose` when tracked.
 *
 * @param document   Closed or evicted document.
 * @param client     Optional running `LspClientSession`.
 */
function closeTrackedDoc(document: TextDocument, client = getRunningClient()): void {
  const uri = readDocUri(document);
  pullResultIds.delete(uri);
  diagnosticCollection?.delete(document.uri);
  if (openDocVersions.delete(uri) && client !== undefined) {
    notifyTextDocument(client, 'didClose', uri);
  }
}

/**
 * Awaits the ready `LspClientSession`, dispatches `method`, and maps the untrusted result.
 *
 * @param method    Full LSP method name.
 * @param params    Request parameter object.
 * @param token     Cancellation token.
 * @param mapFn     Validator and converter returning `R | null`.
 * @param errMode   Error propagation mode (`0 = null`, `1 = Busy`, `2 = rethrow RPC`).
 */
async function requestLsp<R>(
  method: string,
  params: unknown,
  token: CancellationToken,
  mapFn: (rawValue: unknown) => R | null,
  errMode: QueryErrorMode = 0
): Promise<R | null> {
  if (!isCorexActive() || !readExtensionConfig().isLspEnabled) {
    return null;
  }
  const client = await sessionPromise;
  if (client !== activeClient || client?.isRunning() !== true) {
    return null;
  }
  try {
    return mapFn(await client.request(method, params, token));
  } catch (error: unknown) {
    if (!isCanceled(token)) {
      if (errMode === 1 && isJsonRpcRequestError(error) && error.code === LSP_SERVER_CANCELED) {
        throw new Error('Busy', { cause: error });
      } else if (
        errMode === 2 &&
        (!isJsonRpcRequestError(error) || error.code !== LSP_REQUEST_CANCELED)
      ) {
        throw error;
      }
    }
    return null;
  }
}

/**
 * Executes a `textDocument/*` LSP query and maps the untrusted result.
 *
 * @param document    Target VS Code document.
 * @param subMethod   Method suffix under `textDocument/`.
 * @param extra       Additional request parameters.
 * @param token       Cancellation token.
 * @param mapFn       Validator and converter returning `R | null`.
 * @param errMode     Error propagation mode (`0 = null`, `1 = Busy`, `2 = rethrow RPC`).
 */
function queryDoc<R>(
  document: TextDocument,
  subMethod: string,
  extra: Readonly<Record<string, unknown>>,
  token: CancellationToken,
  mapFn: (rawValue: unknown) => R | null,
  errMode: QueryErrorMode = 0
): Promise<R | null> | null {
  return isCorexFileDoc(document)
    ? requestLsp(
        TEXT_DOC_PREFIX + subMethod,
        { ...extra, textDocument: { uri: readDocUri(document) } },
        token,
        mapFn,
        errMode
      )
    : null;
}

/**
 * Executes a position-based `textDocument/*` LSP query.
 *
 * @param document    Target VS Code document.
 * @param subMethod   Method suffix under `textDocument/`.
 * @param position    Cursor position.
 * @param token       Cancellation token.
 * @param mapFn       Validator and converter returning `R | null`.
 * @param extra       Optional additional parameters.
 * @param errMode     Error propagation mode.
 */
function queryPos<R>(
  document: TextDocument,
  subMethod: string,
  position: Position,
  token: CancellationToken,
  mapFn: (rawValue: unknown) => R | null,
  extra?: Readonly<Record<string, unknown>>,
  errMode: QueryErrorMode = 0
): Promise<R | null> | null {
  return queryDoc(
    document,
    subMethod,
    { ...extra, position: toLspPos(position) },
    token,
    mapFn,
    errMode
  );
}

/** Maps an untrusted `documentHighlight` response array into `DocumentHighlight[] | null`. */
const mapDocHighlights = buildListMapper(
  (hit: LspDocumentHighlight) =>
    new DocumentHighlight(
      toVsRange(hit.range),
      shiftEnum(hit.kind ?? 1, 2) as DocumentHighlightKind
    )
);

/**
 * Handles inbound `textDocument/publishDiagnostics`, dropping closed-tab and stale-version frames.
 *
 * @param params   Inbound `publishDiagnostics` notification payload.
 */
function handlePublishDiagnostics(params: LspPublishDiagnosticsParams): void {
  const targetUri = parseVsUri(params.uri);
  const canonicalUri = targetUri.toString();
  pullResultIds.delete(canonicalUri);
  const knownVer = openDocVersions.get(canonicalUri);
  if (knownVer === undefined || (params.version !== undefined && params.version < knownVer)) {
    return;
  }
  diagnosticCollection?.set(targetUri, toVsDiagnostics(params.diagnostics));
}

/**
 * Refreshes diagnostics across all currently open `.cx` tabs (optionally skipping `excludedUri`).
 *
 * @param excludedUri   Optional URI already updated by `didSave` push diagnostics.
 */
function refreshSiblingDocs(excludedUri?: string): void {
  const client = getRunningClient();
  if (client === undefined) {
    return;
  }
  for (const [uri, ver] of openDocVersions) {
    if (uri !== excludedUri) {
      runDetached(
        client
          .request(`${TEXT_DOC_PREFIX}diagnostic`, {
            previousResultId: pullResultIds.get(uri),
            textDocument: { uri },
          })
          .then((report) => {
            if (isRecord(report) && activeClient === client && openDocVersions.get(uri) === ver) {
              if (isStr(report.resultId)) {
                putBounded(pullResultIds, uri, report.resultId);
              }
              if (report.kind === 'full' && isArray(report.items)) {
                diagnosticCollection?.set(
                  parseVsUri(uri),
                  toVsDiagnostics(report.items as readonly LspDiagnostic[])
                );
              }
            }
          })
      );
    }
  }
}

// --------------------- Language Providers ---------------------

/**
 * Builds a `provideDocument<mid>SemanticTokens` method identifier.
 *
 * @param mid   Infix token (`''` or `'Range'`).
 */
function buildSemMethod(mid: string): string {
  return `provideDocument${mid}SemanticTokens`;
}

/**
 * Expands shorthand `'#'` prefixes into `'Document'` and strips plural `'*'` markers.
 *
 * @param kind   Provider base name with optional `'#'` prefix or trailing `'*'`.
 */
function expandDocKind(kind: string): string {
  return kind.replace('#', 'Document').replace('*', '');
}

/**
 * Converts a `PascalCase` provider name into its `camelCase` LSP method suffix.
 *
 * @param pascalName   Expanded VS Code provider name.
 */
function toCamelMethod(pascalName: string): string {
  return pascalName.charAt(0).toLowerCase() + pascalName.slice(1);
}

/**
 * Invokes `vscode.languages.register<kind>Provider(...args)` dynamically.
 *
 * @param kind   VS Code provider base name (`'#'` expands to `'Document'`).
 * @param args   Arguments forwarded to the registration method.
 */
function registerLangProvider(kind: string, ...args: unknown[]): Disposable {
  return (vsLanguages as unknown as Record<string, (...rest: unknown[]) => Disposable>)[
    `register${expandDocKind(kind)}Provider`
  ]?.(...(kind === 'WorkspaceSymbol' ? args : [COREX_SELECTOR, ...args])) as Disposable;
}

/**
 * Registers a single-method `vscode.languages.register<kind>Provider` (`'*'` suffix adds plural `'s'`).
 *
 * @param kind      VS Code provider base name (`'#'` = `'Document'`, trailing `'*'` = plural `'s'`).
 * @param handler   Provider method implementation.
 * @param extra     Optional trailing registration arguments (trigger chars, metadata).
 */
function registerSingleProvider(kind: string, handler: unknown, ...extra: unknown[]): Disposable {
  const fullKind = expandDocKind(kind);
  return registerLangProvider(
    fullKind,
    { [`provide${fullKind}${kind.endsWith('*') ? 's' : ''}`]: handler },
    ...extra
  );
}

/**
 * Registers a position-based `textDocument/*` provider deriving its LSP method name when `lspOverride` is `''`.
 *
 * @param kind          VS Code provider base name (`'#'` = `'Document'`, trailing `'*'` = plural `'s'`).
 * @param lspOverride   Explicit LSP sub-method override (`''` derives `camelCase` from `kind`).
 * @param mapFn         Validator and converter returning `R | null`.
 * @param extra         Optional trailing registration arguments.
 */
function registerPosProvider<R>(
  kind: string,
  lspOverride: string,
  mapFn: (rawValue: unknown) => R | null,
  ...extra: unknown[]
): Disposable {
  const subMethod = lspOverride || toCamelMethod(expandDocKind(kind));
  return registerSingleProvider(
    kind,
    (document: TextDocument, position: Position, token: CancellationToken) =>
      queryPos(document, subMethod, position, token, mapFn),
    ...extra
  );
}

/** Synchronizes `DocumentFormattingEditProvider` and `DocumentRangeFormattingEditProvider` registrations. */
function syncFormatProviders(): void {
  disposeList(formatProviderSubs);
  const cfg = readExtensionConfig();
  if (!isCorexActive() || !cfg.isFormatEnabled) {
    return;
  }

  formatProviderSubs.push(
    registerSingleProvider(
      '#FormattingEdit*',
      async (document: TextDocument, options: unknown, token: CancellationToken) => {
        if (!isCorexActive() || !isCorexFileDoc(document)) {
          return null;
        }
        const latestCfg = readExtensionConfig();
        if (latestCfg.isLspEnabled) {
          const edits = await queryDoc(document, 'formatting', { options }, token, mapEditList);
          if (edits || isCanceled(token) || getRunningClient()) {
            return edits && appendLfEdit(document, edits);
          }
        }
        const [workspaceDirs] = collectWorkspaces();
        const binaryRes = resolveCorexBinary(latestCfg.executablePath, { workspaceDirs });
        if (!binaryRes.isFound) {
          logWarn(BINARY_NOT_FOUND_MSG);
          return null;
        }
        const originalText = document.getText();
        const formattedText = await runCorexFmtCli(
          binaryRes.binaryPath,
          originalText,
          isInternalCoreEnabled(latestCfg.internalCore, workspaceDirs, [document.uri.fsPath]),
          token
        );
        if (formattedText === null) {
          return null;
        }
        const diff = computeMinimalUtf16Edit(originalText, formattedText);
        return appendLfEdit(document, diff ? [toVsEdit(diff)] : []);
      }
    )
  );

  if (cfg.isLspEnabled) {
    formatProviderSubs.push(
      registerSingleProvider(
        '#RangeFormattingEdit*',
        (document: TextDocument, range: Range, options: unknown, token: CancellationToken) =>
          queryDoc(
            document,
            'rangeFormatting',
            { ...toRangeParam(range), options },
            token,
            mapEditList
          )
      )
    );
  }
}

/**
 * Queries `textDocument/semanticTokens/<subPath>` with `-32802` Busy propagation.
 *
 * @param document   Target VS Code document.
 * @param subPath    Endpoint suffix under `textDocument/semanticTokens/`.
 * @param extra      Additional request parameters.
 * @param token      Cancellation token.
 * @param mapFn      Response converter (`mapSemTokens` by default).
 */
function querySem<R = SemanticTokens>(
  document: TextDocument,
  subPath: string,
  extra: Readonly<Record<string, unknown>>,
  token: CancellationToken,
  mapFn: (rawValue: unknown) => R | null = mapSemTokens as (rawValue: unknown) => R | null
): Promise<R | null> | null {
  return queryDoc(document, `semanticTokens/${subPath}`, extra, token, mapFn, 1);
}

/** Registers all LSP-backed VS Code language providers so early requests await `sessionPromise`. */
function ensureLspProviders(): void {
  if (lspProviderSubs.length > 0 || inlayHintsEmitter === undefined) {
    return;
  }
  const legend = new SemanticTokensLegend(
    (
      'namespace,type,struct,enum,interface,typeParameter,parameter,variable,property,enumMember,' +
      'function,method,macro,keyword,modifier,comment,string,number,operator,decorator'
    ).split(','),
    (
      'declaration,definition,readonly,static,deprecated,abstract,async,modification,documentation,' +
      'defaultLibrary,mutable,consumedMove,unsafe,attribute,linearResource'
    ).split(',')
  );
  const fullSemMethod = buildSemMethod('');
  const semProvider = {
    [buildSemMethod('Range')]: (document: TextDocument, range: Range, token: CancellationToken) =>
      querySem(document, 'range', toRangeParam(range), token),
    [fullSemMethod]: (document: TextDocument, token: CancellationToken) =>
      querySem(document, 'full', {}, token),
    [`${fullSemMethod}Edits`]: (
      document: TextDocument,
      previousResultId: string,
      token: CancellationToken
    ) =>
      querySem<SemanticTokens | SemanticTokensEdits>(
        document,
        'full/delta',
        { previousResultId },
        token,
        (rawValue) =>
          hasArrayProp(rawValue, 'edits')
            ? new SemanticTokensEdits(
                mapList(
                  rawValue.edits as readonly LspSemanticTokensEdit[],
                  (tokenEdit) =>
                    new SemanticTokensEdit(
                      tokenEdit.start,
                      tokenEdit.deleteCount,
                      tokenEdit.data && new Uint32Array(tokenEdit.data)
                    )
                ),
                readOptStr(rawValue.resultId)
              )
            : mapSemTokens(rawValue)
      ),
  };

  lspProviderSubs.push(
    ...mapList(['#', '#Range'], (prefix) =>
      registerLangProvider(`${prefix}SemanticTokens`, semProvider, legend)
    ),
    registerPosProvider('Hover', '', (rawValue) => {
      const content = isRecord(rawValue) && toVsDoc(rawValue.contents);
      return content ? new Hover(content, tryVsRange(rawValue.range)) : null;
    }),
    ...mapList(['', 'Type'], (prefix) =>
      registerPosProvider(`${prefix}Definition`, '', mapLocations)
    ),
    registerPosProvider('#Highlight*', '', mapDocHighlights),
    registerSingleProvider(
      'Reference*',
      (
        document: TextDocument,
        position: Position,
        refContext: ReferenceContext,
        token: CancellationToken
      ) =>
        queryPos(document, 'references', position, token, mapLocationList, {
          context: { includeDeclaration: refContext.includeDeclaration },
        })
    ),
    registerSingleProvider('#Symbol*', (document: TextDocument, token: CancellationToken) =>
      queryDoc(document, 'documentSymbol', {}, token, mapDocSymbolList)
    ),
    registerLangProvider('WorkspaceSymbol', {
      provideWorkspaceSymbols: (query: string, token: CancellationToken) =>
        requestLsp(
          'workspace/symbol',
          { query },
          token,
          buildListMapper((rawSym: LspSymbolInformation) =>
            assignProps(
              new SymbolInformation(
                rawSym.name,
                shiftEnum(rawSym.kind, 25) as SymbolKind,
                rawSym.containerName ?? '',
                toVsLocation(rawSym.location)
              ),
              { tags: pickTags<SymbolTag>(rawSym.tags) }
            )
          )
        ),
    }),
    registerPosProvider(
      'CompletionItem*',
      'completion',
      (rawValue) => {
        const rawItems = hasArrayProp(rawValue, 'items') ? rawValue.items : rawValue;
        return isArray(rawItems)
          ? new CompletionList(
              mapList(rawItems as readonly LspCompletionItem[], (rawItem, i) =>
                assignProps(
                  new CompletionItem(
                    rawItem.label,
                    rawItem.kind ? (shiftEnum(rawItem.kind, 24) as CompletionItemKind) : undefined
                  ),
                  {
                    detail: rawItem.detail,
                    documentation: toVsDoc(rawItem.documentation),
                    insertText: rawItem.textEdit?.newText ?? rawItem.insertText,
                    range: rawItem.textEdit && toVsRange(rawItem.textEdit.range),
                    sortText: String(10_000 + i).slice(1),
                    tags: pickTags<CompletionItemTag>(rawItem.tags),
                  }
                )
              ),
              Boolean(isRecord(rawValue) && rawValue.isIncomplete)
            )
          : null;
      },
      '.',
      '@',
      ':'
    ),
    registerPosProvider(
      'SignatureHelp',
      '',
      (rawValue) =>
        hasArrayProp(rawValue, 'signatures')
          ? assignProps(new SignatureHelp(), {
              activeParameter: toNonNegInt(rawValue.activeParameter),
              activeSignature: toNonNegInt(rawValue.activeSignature),
              signatures: mapList(
                rawValue.signatures as readonly LspSignatureInformation[],
                (rawSig) =>
                  assignProps(
                    new SignatureInformation(rawSig.label, toVsDoc(rawSig.documentation)),
                    {
                      activeParameter: rawSig.activeParameter,
                      parameters: mapList(
                        rawSig.parameters ?? [],
                        (param) =>
                          new ParameterInformation(
                            param.label as string | [number, number],
                            toVsDoc(param.documentation)
                          )
                      ),
                    }
                  )
              ),
            })
          : null,
      { retriggerCharacters: [','], triggerCharacters: ['(', ',', '['] }
    ),
    registerLangProvider('InlayHints', {
      onDidChangeInlayHints: inlayHintsEmitter.event,
      provideInlayHints: (document: TextDocument, range: Range, token: CancellationToken) =>
        readExtensionConfig().isInlayHintsEnabled
          ? queryDoc(
              document,
              'inlayHint',
              toRangeParam(range),
              token,
              buildListMapper((rawHint: LspInlayHint) =>
                assignProps(
                  new InlayHint(
                    toVsPos(rawHint.position),
                    rawHint.label,
                    rawHint.kind === 1 || rawHint.kind === 2
                      ? (rawHint.kind as InlayHintKind)
                      : undefined
                  ),
                  {
                    paddingLeft: rawHint.paddingLeft,
                    paddingRight: rawHint.paddingRight,
                    textEdits: rawHint.textEdits && mapList(rawHint.textEdits, toVsEdit),
                    tooltip: toVsDoc(rawHint.tooltip),
                  }
                )
              )
            )
          : [],
    }),
    registerSingleProvider(
      'CodeActions',
      (document: TextDocument, range: Range, _context: unknown, token: CancellationToken) =>
        queryDoc(
          document,
          'codeAction',
          { ...toRangeParam(range), context: { only: [QUICK_FIX_KIND] } },
          token,
          buildListMapper((rawAction: LspCodeAction) =>
            assignProps(new CodeAction(rawAction.title, QUICK_FIX_KIND), {
              diagnostics: rawAction.diagnostics && toVsDiagnostics(rawAction.diagnostics),
              edit: toVsWorkspaceEdit(rawAction.edit) ?? undefined,
              isPreferred: rawAction.isPreferred,
            })
          )
        ),
      { providedCodeActionKinds: [QUICK_FIX_KIND] }
    ),
    registerLangProvider('Rename', {
      async prepareRename(document: TextDocument, position: Position, token: CancellationToken) {
        const prep = await queryPos(document, 'prepareRename', position, token, (rawValue) => {
          const range =
            isRecord(rawValue) && isStr(rawValue.placeholder) && tryVsRange(rawValue.range);
          return range ? { placeholder: rawValue.placeholder as string, range } : null;
        });
        if (!prep && !isCanceled(token)) {
          throw new Error('This symbol cannot be renamed.');
        }
        return prep ?? undefined;
      },
      provideRenameEdits: (
        document: TextDocument,
        position: Position,
        newName: string,
        token: CancellationToken
      ) => queryPos(document, 'rename', position, token, toVsWorkspaceEdit, { newName }, 2),
    })
  );
}

// --------------------- Server Supervision ---------------------

/**
 * Displays an error toast with a primary command button and `'Show Output'`.
 *
 * @param message         Error message text.
 * @param primaryButton   Primary action label.
 * @param commandId       VS Code command ID to execute when `primaryButton` is selected.
 * @param commandArg      Optional argument passed to `commandId`.
 */
function showErrorPrompt(
  message: string,
  primaryButton: string,
  commandId: string,
  commandArg?: string
): void {
  runDetached(
    vsWindow
      .showErrorMessage(message, primaryButton, 'Show Output')
      .then((choice) =>
        choice === primaryButton ? execVsCmd(commandId, commandArg) : choice && showOutputChannel()
      )
  );
}

/** Clears open-document tracking maps and diagnostics without touching `sessionPromise`. */
function clearSessionTracking(): void {
  activeClient = undefined;
  openDocVersions.clear();
  pullResultIds.clear();
  diagnosticCollection?.clear();
}

/**
 * Updates the status bar to `'error'` and logs `message` to the `CoreX` output channel.
 *
 * @param message   Error summary text.
 * @param error     Optional underlying error detail.
 */
function reportErrorStatus(message: string, error?: unknown): void {
  setStatus('error', message);
  logError(message, error);
}

/**
 * Supervises unexpected `corex lsp` exits (`<= 4` automatic restarts within `60_000 ms`).
 *
 * @param exitCode         Child exit status code.
 * @param signal           Termination signal if killed.
 * @param restartTrigger   Callback launching the next server generation.
 */
function onUnexpectedExit(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  restartTrigger: () => void
): void {
  if (isDeactivated) {
    return;
  }
  clearSessionTracking();
  const now = Date.now();
  while ((crashTimestamps[0] ?? now) < now - 60_000) {
    crashTimestamps.shift();
  }
  logError(`Exit ${exitCode}/${signal}`);
  if (crashTimestamps.push(now) > 4) {
    const msg = 'CoreX LSP crashed.';
    reportErrorStatus(msg);
    showErrorPrompt(msg, 'Restart', corexId(SUB_RESTART));
    return;
  }
  const delay = 250 * 2 ** (crashTimestamps.length - 1);
  setStatus('sync~spin', `Retry in ${delay} ms…`);
  clearTimer(crashTimer);
  crashTimer = setTimer(() => {
    crashTimer = undefined;
    if (!isDeactivated) {
      restartTrigger();
    }
  }, delay);
}

/**
 * Reports a missing `corex` binary to the status bar, output channel, and (for explicit paths) toast.
 *
 * @param missing   Failed binary discovery result.
 */
function reportMissingBinary(missing: BinaryResolutionMissing): void {
  if (missing.reason === 'not-found') {
    setStatus('warning', BINARY_NOT_FOUND_MSG);
    logWarn(BINARY_NOT_FOUND_MSG);
    return;
  }
  const candidate = missing.configuredCandidate ?? readExtensionConfig().executablePath;
  const msg = `Missing: ${candidate}`;
  reportErrorStatus(msg);
  if (lastMissingKey !== candidate) {
    lastMissingKey = candidate;
    showErrorPrompt(msg, 'Settings', CMD_OPEN_SETTINGS, corexId(EXEC_PATH_KEY));
  }
}

/**
 * Synchronizes providers and status bar against Workspace Trust, manual stop state, and `corex.lsp.enable`.
 *
 * @param cfg   Current validated configuration snapshot.
 */
function hasActiveLspGate(cfg: ExtensionConfig): boolean {
  syncFormatProviders();
  if (isCorexActive() && cfg.isLspEnabled && !isManuallyStopped) {
    ensureLspProviders();
    return true;
  }
  disposeList(lspProviderSubs);
  if (!vsWorkspace.isTrusted) {
    setStatus('warning', 'Untrusted.');
  } else if (!cfg.isEnabled) {
    statusBarItem?.hide();
  } else if (isManuallyStopped) {
    setStatus('circle-slash', 'Stopped.');
  } else {
    setStatus('warning', cfg.isFormatEnabled ? 'CLI fmt.' : 'Off.');
  }
  return false;
}

/** Reconciles `corex lsp`, formatting providers, and status bar against Workspace Trust & config. */
function reconcileSession(): Promise<LspClientSession | undefined> {
  sessionGen += 1;
  const gen = sessionGen;
  const prevPromise = sessionPromise;
  sessionPromise = (async (): Promise<LspClientSession | undefined> => {
    await prevPromise.catch(() => undefined);
    clearTimer(crashTimer);
    crashTimer = undefined;
    const prevClient = activeClient;
    clearSessionTracking();
    await prevClient?.stop();
    const cfg = readExtensionConfig();
    if (isDeactivated || gen !== sessionGen || !hasActiveLspGate(cfg)) {
      return undefined;
    }

    const [workspaceDirs, workspaceFolders] = collectWorkspaces();
    const binaryRes = resolveCorexBinary(cfg.executablePath, { workspaceDirs });
    if (!binaryRes.isFound) {
      reportMissingBinary(binaryRes);
      return undefined;
    }

    lastMissingKey = undefined;
    const openCxPaths: string[] = [];
    forEachOpenCxDoc((doc) => openCxPaths.push(doc.uri.fsPath));
    const { binaryPath } = binaryRes;
    const isInternalCore = isInternalCoreEnabled(cfg.internalCore, workspaceDirs, openCxPaths);
    setStatus('sync~spin', 'Starting…');
    logInfo(`Start ${binaryPath}`);

    try {
      const client = await startLspClient({
        binaryPath,
        cwd: workspaceDirs[0] ?? (openCxPaths[0] && pathDirname(openCxPaths[0])),
        isInternalCore,
        onExit: (exitCode, signal, isUnexpected) => {
          if (isUnexpected && activeClient === client) {
            onUnexpectedExit(exitCode, signal, () => runDetached(reconcileSession()));
          }
        },
        onProtocolError: logWarn,
        onPublishDiagnostics: (params) => {
          if (activeClient === client) {
            handlePublishDiagnostics(params);
          }
        },
        onStderr: (line) => logInfo(`[lsp] ${line}`),
        onTrace: logTrace,
        traceMode: cfg.traceServer,
        workspaceFolders,
      });

      if (isDeactivated || gen !== sessionGen) {
        await client.stop();
        return undefined;
      }

      activeClient = client;
      forEachOpenCxDoc((doc) => syncOpenedDoc(client, doc));
      inlayHintsEmitter?.fire();

      const readyBanner = `CoreX LSP v${client.initializeResult.serverInfo?.version ?? '0.1.0'}${isInternalCore ? ` [${INTERNAL_CORE_FLAG}]` : ''}`;
      setStatus('check', readyBanner);
      logInfo(readyBanner);
      return client;
    } catch (error: unknown) {
      if (!isDeactivated && gen === sessionGen) {
        reportErrorStatus('LSP failed.', error);
      }
      return undefined;
    }
  })();
  return sessionPromise;
}

/** Reloads configuration, clears manual-stop/crash/binary guards, and reconciles the session. */
function reconcileFresh(): Promise<LspClientSession | undefined> {
  isManuallyStopped = false;
  invalidateConfigCache();
  crashTimestamps.length = 0;
  lastMissingKey = undefined;
  return reconcileSession();
}

/** Triggers a detached fresh session reconciliation. */
function triggerFreshReconcile(): void {
  runDetached(reconcileFresh());
}

/** Starts or restarts `corex lsp` on user command, warning if the workspace is untrusted. */
function restartFromCommand(): Promise<LspClientSession | undefined> | undefined {
  if (!vsWorkspace.isTrusted) {
    runDetached(vsWindow.showWarningMessage('Grant Workspace Trust to run CoreX.'));
    return undefined;
  }
  return reconcileFresh();
}

/** Stops any running `corex lsp` server until restarted by the user or configuration change. */
function stopServerManually(): Promise<LspClientSession | undefined> | undefined {
  if (!vsWorkspace.isTrusted) {
    return undefined;
  }
  isManuallyStopped = true;
  return reconcileSession();
}

/** Toggles `corex.inlayHints.enable` in user configuration. */
function toggleInlayHintsCommand(): Thenable<void> {
  return vsWorkspace
    .getConfiguration(COREX_CONFIG_SECTION)
    .update(INLAY_HINTS_KEY, !readExtensionConfig().isInlayHintsEnabled, true);
}

/** Opens the Oxc-style dual-service (`Language Server` + `Formatter`) status-bar QuickPick menu. */
function openStatusMenu(): PromiseLike<unknown> {
  const [client, lspStatus, fmtStatus, hintsStatus] = describeServices();
  return vsWindow
    .showQuickPick(
      mapList(
        [
          [LSP_SERVICE_LABEL],
          ['$(output) Show Output', showOutputChannel, lspStatus],
          [`$(refresh) Restart ${LANG_SERVER_TEXT}`, restartFromCommand],
          [
            `$(${client ? 'stop' : 'play'}-circle) ${client ? 'Stop' : 'Start'} ${LANG_SERVER_TEXT}`,
            client ? stopServerManually : restartFromCommand,
          ],
          ['$(eye) Inlay Hints', toggleInlayHintsCommand, hintsStatus],
          [FMT_SERVICE_LABEL],
          ['$(wand) Format', () => execVsCmd('editor.action.formatDocument'), fmtStatus],
          ['$(gear) Settings', () => execVsCmd(CMD_OPEN_SETTINGS, COREX_CONFIG_SECTION)],
        ] as readonly (readonly [string, (() => unknown)?, string?])[],
        ([label, action, description]): StatusMenuEntry =>
          action ? { action, description, label } : { kind: -1 as QuickPickItemKind, label }
      ),
      { title: 'CoreX' }
    )
    .then((pickedItem) => pickedItem?.action?.());
}

/**
 * Subscribes to `target.onDid<name>` (`'#'` expands to `'TextDocument'`).
 *
 * @param target     VS Code `workspace` or `FileSystemWatcher` event source.
 * @param name       Event suffix under `onDid` (`'#'` = `'TextDocument'`).
 * @param listener   Event callback.
 */
function subscribeDidEvent<T>(
  target: unknown,
  name: string,
  listener: (event: T) => unknown
): Disposable {
  return (target as Record<string, (cb: (event: T) => unknown) => Disposable>)[
    `onDid${name.replace('#', 'TextDocument')}`
  ]?.(listener) as Disposable;
}

/**
 * Enqueues a `FileSystemWatcher` event and schedules a `75 ms` debounced `didChangeWatchedFiles` flush.
 *
 * @param uri          Affected file URI.
 * @param changeType   LSP `FileChangeType` (`1 = Created`, `2 = Changed`, `3 = Deleted`).
 */
function recordWatchedEvent(uri: Uri, changeType: LspFileChangeType): void {
  if (
    isDeactivated ||
    !isCorexActive() ||
    uri.scheme !== 'file' ||
    hasIgnoredSegment(vsWorkspace.asRelativePath(uri, false))
  ) {
    return;
  }
  const canonicalUri = uri.toString();
  if (!isValidUri(canonicalUri)) {
    return;
  }
  if (changeType === 3) {
    pullResultIds.delete(canonicalUri);
  }
  const prevType = pendingWatchedEvents.get(canonicalUri);
  if (prevType === 1 && changeType === 3) {
    pendingWatchedEvents.delete(canonicalUri);
    return;
  }
  putBounded(
    pendingWatchedEvents,
    canonicalUri,
    prevType === 1 && changeType === 2 ? 1 : changeType
  );

  clearTimer(watcherTimer);
  watcherTimer = setTimer(() => {
    watcherTimer = undefined;
    const client = getRunningClient();
    if (client !== undefined && pendingWatchedEvents.size > 0) {
      const changes: LspFileEvent[] = [];
      for (const [watchedUri, watchedType] of pendingWatchedEvents) {
        changes.push({ type: watchedType, uri: watchedUri });
      }
      client.notify('workspace/didChangeWatchedFiles', { changes });
      refreshSiblingDocs();
    }
    pendingWatchedEvents.clear();
  }, 75);
}

// ------------------------------------- PUBLIC API --------------------------------------

/**
 * Activates the CoreX VS Code extension (`onLanguage:corex`, `workspaceContains:corex.toml`).
 *
 * @param context   VS Code extension host lifecycle context.
 */
export function activate(context: ExtensionContext): void {
  isDeactivated = false;
  diagnosticCollection = vsLanguages.createDiagnosticCollection(COREX_CONFIG_SECTION);
  inlayHintsEmitter = new EventEmitter<void>();
  const watcher = vsWorkspace.createFileSystemWatcher('**/{*.cx,corex.toml,corex.lock}');

  const { subscriptions } = context;
  for (const [subCmd, handler] of [
    [SUB_OUTPUT, showOutputChannel],
    [SUB_RESTART, restartFromCommand],
    [SUB_STOP, stopServerManually],
    [SUB_STATUS, openStatusMenu],
    [SUB_HINTS, toggleInlayHintsCommand],
  ] as const) {
    subscriptions.push(commands.registerCommand(corexId(subCmd), handler));
  }
  subscriptions.push(
    subscribeDidEvent<TextDocument>(vsWorkspace, 'Open#', (document) =>
      withRunningDoc(document, (client, uri) => {
        if (!openDocVersions.has(uri)) {
          syncOpenedDoc(client, document, uri);
        }
      })
    ),
    subscribeDidEvent<{
      readonly contentChanges: readonly { readonly range: Range; readonly text: string }[];
      readonly document: TextDocument;
    }>(vsWorkspace, 'Change#', ({ contentChanges, document }) => {
      if (contentChanges[0]) {
        withRunningDoc(document, (client, uri) => {
          pullResultIds.delete(uri);
          if (!openDocVersions.has(uri)) {
            syncOpenedDoc(client, document, uri);
          } else if (
            notifyTextDocument(client, 'didChange', uri, {
              contentChanges: mapList(contentChanges, (change) => ({
                ...toRangeParam(change.range),
                text: change.text,
              })),
              textDocument: { version: document.version },
            })
          ) {
            openDocVersions.set(uri, document.version);
          } else {
            closeTrackedDoc(document, client);
          }
        });
      }
    }),
    subscribeDidEvent<TextDocument>(vsWorkspace, 'Save#', (document) =>
      withRunningDoc(document, (client, uri) => {
        notifyTextDocument(client, 'didSave', uri, { text: document.getText() });
        refreshSiblingDocs(uri);
      })
    ),
    subscribeDidEvent<TextDocument>(vsWorkspace, 'Close#', (document) => closeTrackedDoc(document)),
    subscribeDidEvent(vsWorkspace, 'GrantWorkspaceTrust', triggerFreshReconcile),
    subscribeDidEvent(vsWorkspace, 'ChangeWorkspaceFolders', () => {
      if (vsWorkspace.isTrusted) {
        triggerFreshReconcile();
      }
    }),
    subscribeDidEvent<{ readonly affectsConfiguration: (section: string) => boolean }>(
      vsWorkspace,
      'ChangeConfiguration',
      (configEvent) => {
        if (configEvent.affectsConfiguration(COREX_CONFIG_SECTION)) {
          const prevConfig = readExtensionConfig();
          invalidateConfigCache();
          const nextConfig = readExtensionConfig();
          if (hasServerRestartConfigChange(prevConfig, nextConfig)) {
            triggerFreshReconcile();
          } else {
            if (prevConfig.traceServer !== nextConfig.traceServer) {
              activeClient?.setTraceMode(nextConfig.traceServer);
            }
            if (prevConfig.isFormatEnabled !== nextConfig.isFormatEnabled) {
              syncFormatProviders();
            }
            if (prevConfig.isInlayHintsEnabled !== nextConfig.isInlayHintsEnabled) {
              inlayHintsEmitter?.fire();
            }
            if (lastStatusState && nextConfig.isEnabled) {
              setStatus(...lastStatusState);
            }
          }
        }
      }
    ),
    ...mapList(['Create', 'Change', 'Delete'] as const, (evName, idx) =>
      subscribeDidEvent<Uri>(watcher, evName, (uri) =>
        recordWatchedEvent(uri, (idx + 1) as LspFileChangeType)
      )
    ),
    watcher
  );

  triggerFreshReconcile();
}

/** Cleanly shuts down `corex lsp` and disposes all extension host resources. */
export async function deactivate(): Promise<void> {
  isDeactivated = true;
  isManuallyStopped = false;
  lastStatusState = undefined;
  clearTimer(watcherTimer);
  watcherTimer = undefined;
  await reconcileSession();
  disposeList(lspProviderSubs);
  disposeList(formatProviderSubs);
  for (const item of [statusBarItem, inlayHintsEmitter, diagnosticCollection]) {
    item?.dispose();
  }
  statusBarItem = undefined;
  inlayHintsEmitter = undefined;
  diagnosticCollection = undefined;
  pendingWatchedEvents.clear();
  crashTimestamps.length = 0;
  disposeLogger();
}

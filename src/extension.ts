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
  TextEditor,
  TextEditorDecorationType,
} from 'vscode';
import { isInternalCoreEnabled, pathDirname, resolveCorexBinary, splitCsv } from '@/binary';
import {
  assignProps,
  clearTimer,
  hasArrayProp,
  INTERNAL_CORE_FLAG,
  isArray,
  isCanceled,
  isJsonRpcRequestError,
  isRecord,
  isStr,
  isValidUri,
  LSP_REQUEST_CANCELED,
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
  LspClientSession,
  LspCodeAction,
  LspCompletionItem,
  LspDiagnostic,
  LspDocumentHighlight,
  LspDocumentSymbol,
  LspFileChangeType,
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

/** Local alias binding `MarkdownString` to a mangleable identifier. */
const VsMarkdown = MarkdownString;

/** Local alias binding `Range` to a mangleable identifier. */
const VsRange = Range;

/** Local alias binding `TextEdit` to a mangleable identifier. */
const VsTextEdit = TextEdit;

/** Local alias binding `ThemeColor` to a mangleable identifier. */
const VsThemeColor = ThemeColor;

/** Local alias binding `Uri` to a mangleable identifier. */
const VsUri = Uri;

/** Shared `'Language Server'` title fragment. */
const LANG_SERVER_TEXT = 'Language Server';

/** Shared display label for the Language Server service. */
const LSP_SERVICE_LABEL = `${LANG_SERVER_TEXT} (\`corex lsp\`)`;

/** Shared display label for the Formatter service. */
const FMT_SERVICE_LABEL = 'Formatter (`corex fmt`)';

/** Shared UI words & `corex.*` command suffixes. */
const [
  DOC_WORD,
  DISABLED_TEXT,
  SHOW_OUTPUT_LABEL,
  RESTART_LABEL,
  SETTINGS_LABEL,
  INLAY_HINTS_LABEL,
  SUB_OUTPUT,
  SUB_RESTART,
  SUB_STOP,
  SUB_STATUS,
  SUB_HINTS,
] = splitCsv(
  'Document,Disabled,Show Output,Restart,Settings,Inlay Hints,' +
    'showOutputChannel,restartServer,stopServer,showStatusMenu,toggleInlayHints'
) as [string, string, string, string, string, string, string, string, string, string, string];

/** Local alias binding `CodeActionKind.QuickFix`. */
const QUICK_FIX_KIND = CodeActionKind.QuickFix;

/** Document selector matching local `file:` CoreX documents (`untitled:` excluded). */
const COREX_SELECTOR: DocumentSelector = { language: COREX_CONFIG_SECTION, scheme: 'file' };

/** Built-in VS Code command opening Settings filtered by query. */
const CMD_OPEN_SETTINGS = 'workbench.action.openSettings';

/** Shared warning string when no `corex` binary was auto-discovered. */
const BINARY_NOT_FOUND_MSG = 'Binary not found.';

/** Shared `'SemanticTokens'` provider suffix. */
const SEM_TOKENS = 'SemanticTokens';

// ----------------------------------- REGEX PATTERNS ------------------------------------

/** Matches workspace-relative paths inside ignored build, VCS, or dependency directories. */
const IGNORED_PATH_RX = /(?:^|[\\/])(?:\.(?:corex|git)|build|node_modules|zig-out)(?:[\\/]|$)/;

/** Matches pure variable discard statements (`_ = ident;`) without side-effecting calls or projections. */
const PURE_DISCARD_RX = /^\s*_\s*=\s*(?:[a-z][a-z0-9_]*|_\w+)\s*;\s*(?:\/\/.*)?$/;

/** Matches standalone closing multiline string lines (`^[ ]*"#*`) without trailing identifier characters. */
// oxlint-disable-next-line prefer-named-capture-group -- positional groups avoid unmangleable group keys under 25 KB bundle budget
const CLOSE_MULTILINE_RX = /^( *)"(#*)(?!\w)/;

/** Matches a closed single-line `"…"` or `'…'` literal with backslash escapes. */
const CLOSED_QUOTED_RX = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/;

/** Matches comments, multiline string openers, single-line strings/chars, and `_unused` / word tokens. */
const LINE_TOKEN_RX = new RegExp(
  `${
    // oxlint-disable-next-line prefer-named-capture-group -- positional groups avoid unmangleable group keys under 25 KB bundle budget
    /\/(?:[/|#].*|\*.*?(?:\*\/|$))|(?:\b(?:(?:f|b?r)(#*)|b)|(?<![\w"#]))(")$|\b(f(?=#)|b?r)(#*)"|/
      .source
  }${
    // oxlint-disable-next-line prefer-named-capture-group -- positional groups avoid unmangleable group keys under 25 KB bundle budget
    /\bf"(?:\\.|[^"\\{]|\{\{|\{(?!\{)(?:@|\{(?:@|[^"{}'])*\}|[^"{}'])*\})*"?|(?:\bb)?(?:@|["'].*)|(_\w+)|\w+/
      .source
  }`.replaceAll('@', CLOSED_QUOTED_RX.source),
  'g'
);

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

/** Lazily created `1px` vertical strip-margin guide decoration for multiline strings. */
let stripGuideDecoration: TextEditorDecorationType | undefined = undefined;

/** Lazily created `0.58` opacity dimming decoration for `_ = ident;` discards and `_unused` bindings. */
let mutedDimDecoration: TextEditorDecorationType | undefined = undefined;

/** Debounce timer (`35 ms`) coalescing visible-range and document-edit decoration refreshes. */
let decorationTimer: ReturnType<typeof setTimeout> | undefined = undefined;

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
function formatCorexId(suffix: string): string {
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
  if (client && isCorexFileDoc(document)) {
    handler(client, readDocUri(document));
  }
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
function mapList<T, R>(
  items: readonly T[] | undefined,
  mapper: (item: T, index: number) => R
): R[] {
  const out: R[] = [];
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      out.push(mapper(items[i] as T, i));
    }
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
 * Summarizes `[client, lspStatus, fmtStatus, hintsStatus, toggleLabel]` for the status bar and menu.
 *
 * @param summary   Primary status headline.
 */
function describeServices(
  summary = 'Inactive'
): readonly [LspClientSession | undefined, string, string, string, 'Stop' | 'Start'] {
  const cfg = readExtensionConfig();
  const client = getRunningClient();
  let lspStatus = cfg.isLspEnabled ? summary : DISABLED_TEXT;
  if (!vsWorkspace.isTrusted) {
    lspStatus = 'Untrusted';
  } else if (client) {
    lspStatus = `PID ${client.pid}`;
  } else if (isManuallyStopped) {
    lspStatus = 'Stopped';
  }
  return [
    client,
    lspStatus,
    isCorexActive() && cfg.isFormatEnabled ? `Ready (${client ? 'LSP' : 'CLI'})` : DISABLED_TEXT,
    cfg.isInlayHintsEnabled ? 'On' : 'Off',
    client ? 'Stop' : 'Start',
  ];
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
  const [client, lspStatus, fmtStatus, hintsStatus, toggleLabel] = describeServices(summary);
  const tooltip = new VsMarkdown(
    `**CoreX** – ${summary}

$(${client ? 'check' : icon}) **${LSP_SERVICE_LABEL}:** ${lspStatus}

$(${fmtStatus === DISABLED_TEXT ? 'circle-slash' : 'check'}) **${FMT_SERVICE_LABEL}:** ${fmtStatus}

${mapList(
  [
    ['Output', SUB_OUTPUT],
    [RESTART_LABEL, SUB_RESTART],
    [toggleLabel, client ? SUB_STOP : SUB_RESTART],
    [`${INLAY_HINTS_LABEL}: ${hintsStatus}`, SUB_HINTS],
  ] as const,
  ([label, subCmd]) => `[${label}](command:${formatCorexId(subCmd)}) · `
).join('')}[${SETTINGS_LABEL}](command:${CMD_OPEN_SETTINGS}?%22${COREX_CONFIG_SECTION}%22)`,
    true
  );
  tooltip.isTrusted = true;
  assignProps((statusBarItem ??= vsWindow.createStatusBarItem(2 as StatusBarAlignment, 100)), {
    backgroundColor:
      icon === 'error' || icon === 'warning'
        ? new VsThemeColor(`statusBarItem.${icon}Background`)
        : undefined,
    command: formatCorexId(SUB_STATUS),
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
function toLspPos({ character, line }: Position): LspPosition {
  return { character, line };
}

/**
 * Wraps `range` into `{ range: LspRange }` for range-scoped LSP requests and edits.
 *
 * @param range   VS Code UTF-16 range.
 */
function toRangeParam(range: Range): { readonly range: LspRange } {
  return { range: { end: toLspPos(range.end), start: toLspPos(range.start) } };
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
  return new VsRange(toVsPos(range?.start), toVsPos(range?.end));
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
    VsUri.parse(isValidUri(location.uri) ? location.uri : 'file:///'),
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
  if (edits[0] && (document.eol as number) === 2) {
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
  return valid[0] && valid;
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
    { children: mapList(rawSym.children, toVsDocSymbol), tags: pickTags<SymbolTag>(rawSym.tags) }
  );
}

/**
 * Narrows `string | LspMarkupContent` into `string | MarkdownString | undefined`.
 *
 * @param docVal   Untrusted documentation block.
 */
function toVsDoc(docVal: unknown): string | MarkdownString | undefined {
  if (isRecord(docVal) && isStr(docVal.value)) {
    return docVal.kind === 'markdown' ? new VsMarkdown(docVal.value) : docVal.value;
  }
  return readOptStr(docVal);
}

/**
 * Validates and converts an untrusted `LspWorkspaceEdit` into a `WorkspaceEdit | null`.
 *
 * @param rawEdit   Untrusted workspace edit object.
 */
function toVsWorkspaceEdit(rawEdit: unknown): WorkspaceEdit | null {
  const changes = isRecord(rawEdit) ? rawEdit.changes : null;
  if (changes === null || (changes !== undefined && !isRecord(changes))) {
    return null;
  }
  const edit = new WorkspaceEdit();
  for (const [uri, rawEdits] of Object.entries(changes ?? {})) {
    const mappedEdits = isValidUri(uri) && mapEditList(rawEdits);
    if (mappedEdits) {
      edit.set(VsUri.parse(uri), mappedEdits);
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
    !openDocVersions.has(uri) &&
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
  if (openDocVersions.delete(uri) && client) {
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
  const client =
    isCorexActive() && readExtensionConfig().isLspEnabled ? await sessionPromise : undefined;
  if (client === activeClient && client?.isRunning()) {
    try {
      return mapFn(await client.request(method, params, token));
    } catch (error: unknown) {
      if (
        !isCanceled(token) &&
        errMode > 0 &&
        (!isJsonRpcRequestError(error) || error.code !== LSP_REQUEST_CANCELED)
      ) {
        throw errMode === 1 ? new Error('Busy', { cause: error }) : error;
      }
    }
  }
  return null;
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

/**
 * Refreshes diagnostics across all currently open `.cx` tabs (optionally skipping `excludedUri`).
 *
 * @param excludedUri   Optional URI already updated by `didSave` push diagnostics.
 */
function refreshSiblingDocs(excludedUri?: string): void {
  const client = getRunningClient();
  if (!client) {
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
                  VsUri.parse(uri),
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
 * Expands `'#'` into `'Document'` and removes plural `'*'` markers.
 *
 * @param kind   Provider base name with optional `'#'` prefix or trailing `'*'`.
 */
function cleanProviderKind(kind: string): string {
  return kind.replace('#', DOC_WORD).replace('*', '');
}

/**
 * Registers a `vscode.languages.register<kind>Provider` (`'#'` = `'Document'`, trailing `'*'` = plural `'s'`).
 *
 * @param kind       VS Code provider base name (`'#'` expands to `'Document'`).
 * @param provider   Provider object or single-method callback function.
 * @param extra      Optional trailing registration arguments (trigger chars, metadata).
 */
function registerLangProvider(kind: string, provider: unknown, ...extra: unknown[]): Disposable {
  const fullKind = cleanProviderKind(kind);
  return (languages as unknown as Record<string, (...rest: unknown[]) => Disposable>)[
    `register${fullKind}Provider`
  ]?.(
    ...(fullKind === 'WorkspaceSymbol' ? [] : [COREX_SELECTOR]),
    typeof provider === 'function'
      ? { [`provide${fullKind}${kind.endsWith('*') ? 's' : ''}`]: provider }
      : provider,
    ...extra
  ) as Disposable;
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
  const fullKind = cleanProviderKind(kind);
  const subMethod = lspOverride || fullKind.charAt(0).toLowerCase() + fullKind.slice(1);
  return registerLangProvider(
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
    registerLangProvider(
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
        return formattedText === null
          ? null
          : appendLfEdit(
              document,
              originalText === formattedText
                ? []
                : [new VsTextEdit(new VsRange(0, 0, document.lineCount, 0), formattedText)]
            );
      }
    ),
    ...(cfg.isLspEnabled
      ? [
          registerLangProvider(
            '#RangeFormattingEdit*',
            (document: TextDocument, range: Range, options: unknown, token: CancellationToken) =>
              queryDoc(
                document,
                'rangeFormatting',
                { ...toRangeParam(range), options },
                token,
                mapEditList
              )
          ),
        ]
      : [])
  );
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
      .showErrorMessage(message, primaryButton, SHOW_OUTPUT_LABEL)
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
 * Reconciles `corex lsp`, formatting providers, and status bar against Workspace Trust & config.
 *
 * @param mode   Optional transition mode (`1 = fresh reset`, `2 = manual stop`).
 */
function reconcileSession(mode?: 1 | 2): Promise<LspClientSession | undefined> {
  if (mode === 1) {
    isManuallyStopped = false;
    invalidateConfigCache();
    crashTimestamps.length = 0;
    lastMissingKey = undefined;
  } else if (mode === 2) {
    isManuallyStopped = true;
  }
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
    if (isDeactivated || gen !== sessionGen) {
      return undefined;
    }
    syncFormatProviders();
    if (!isCorexActive() || !cfg.isLspEnabled || isManuallyStopped) {
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
      return undefined;
    }

    /** Spawns and supervises `corex lsp` for generation `gen`. */
    async function launchSession(): Promise<LspClientSession | undefined> {
      if (!lspProviderSubs[0] && inlayHintsEmitter) {
        const legend = new SemanticTokensLegend(
          splitCsv(
            'namespace,type,struct,enum,interface,typeParameter,parameter,variable,property,enumMember,' +
              'function,method,macro,keyword,modifier,comment,string,number,operator,decorator'
          ),
          splitCsv(
            'declaration,definition,readonly,static,deprecated,abstract,async,modification,documentation,' +
              'defaultLibrary,mutable,consumedMove,unsafe,attribute,linearResource'
          )
        );
        const fullSemMethod = `provide${DOC_WORD}${SEM_TOKENS}`;
        const semProvider = {
          [`provide${DOC_WORD}Range${SEM_TOKENS}`]: (
            document: TextDocument,
            range: Range,
            token: CancellationToken
          ) => querySem(document, 'range', toRangeParam(range), token),
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
            registerLangProvider(prefix + SEM_TOKENS, semProvider, legend)
          ),
          registerPosProvider('Hover', '', (rawValue) => {
            const content = isRecord(rawValue) && toVsDoc(rawValue.contents);
            return content ? new Hover(content, tryVsRange(rawValue.range)) : null;
          }),
          ...mapList(['', 'Type'], (prefix) =>
            registerPosProvider(
              `${prefix}Definition`,
              '',
              (rawValue) =>
                mapLocationList(rawValue) ??
                (isRecord(rawValue) && isValidUri(rawValue.uri)
                  ? toVsLocation(rawValue as unknown as LspLocation)
                  : null)
            )
          ),
          registerPosProvider(
            '#Highlight*',
            '',
            buildListMapper(
              (hit: LspDocumentHighlight) =>
                new DocumentHighlight(
                  toVsRange(hit.range),
                  shiftEnum(hit.kind ?? 1, 2) as DocumentHighlightKind
                )
            )
          ),
          registerLangProvider(
            'Reference*',
            (
              document: TextDocument,
              position: Position,
              context: ReferenceContext,
              token: CancellationToken
            ) => queryPos(document, 'references', position, token, mapLocationList, { context })
          ),
          registerLangProvider('#Symbol*', (document: TextDocument, token: CancellationToken) =>
            queryDoc(document, 'documentSymbol', {}, token, buildListMapper(toVsDocSymbol))
          ),
          registerLangProvider('WorkspaceSymbol*', (query: string, token: CancellationToken) =>
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
            )
          ),
          registerPosProvider(
            'CompletionItem*',
            'completion',
            (rawValue) => {
              const rawItems = hasArrayProp(rawValue, 'items') ? rawValue.items : rawValue;
              return isArray(rawItems)
                ? new CompletionList(
                    mapList(rawItems as readonly LspCompletionItem[], (rawItem, i) => {
                      const { textEdit } = rawItem;
                      return assignProps(
                        new CompletionItem(
                          rawItem.label,
                          rawItem.kind
                            ? (shiftEnum(rawItem.kind, 24) as CompletionItemKind)
                            : undefined
                        ),
                        {
                          detail: rawItem.detail,
                          documentation: toVsDoc(rawItem.documentation),
                          insertText: textEdit?.newText ?? rawItem.insertText,
                          range: textEdit && toVsRange(textEdit.range),
                          sortText: `${1e4 + i}`.slice(1),
                          tags: pickTags<CompletionItemTag>(rawItem.tags),
                        }
                      );
                    }),
                    Boolean((rawValue as { isIncomplete?: unknown })?.isIncomplete)
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
                              rawSig.parameters,
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
            { retriggerCharacters: [','], triggerCharacters: [...'(,['] }
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
          registerLangProvider(
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
            async prepareRename(
              document: TextDocument,
              position: Position,
              token: CancellationToken
            ) {
              const prep = await queryPos(
                document,
                'prepareRename',
                position,
                token,
                (rawValue) => {
                  const range =
                    isRecord(rawValue) && isStr(rawValue.placeholder) && tryVsRange(rawValue.range);
                  return range ? { placeholder: rawValue.placeholder as string, range } : null;
                }
              );
              if (!prep && !isCanceled(token)) {
                throw new Error('Cannot rename.');
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

      const [workspaceDirs, workspaceFolders] = collectWorkspaces();
      const binaryRes = resolveCorexBinary(cfg.executablePath, { workspaceDirs });
      if (!binaryRes.isFound) {
        if (binaryRes.reason === 'not-found') {
          setStatus('warning', BINARY_NOT_FOUND_MSG);
          logWarn(BINARY_NOT_FOUND_MSG);
        } else {
          const candidate = binaryRes.configuredCandidate ?? cfg.executablePath;
          const msg = `Missing: ${candidate}`;
          reportErrorStatus(msg);
          if (lastMissingKey !== candidate) {
            lastMissingKey = candidate;
            showErrorPrompt(msg, SETTINGS_LABEL, CMD_OPEN_SETTINGS, formatCorexId(EXEC_PATH_KEY));
          }
        }
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
            if (!isUnexpected || activeClient !== client || isDeactivated) {
              return;
            }
            clearSessionTracking();
            const now = Date.now();
            while ((crashTimestamps[0] ?? now) < now - 60_000) {
              crashTimestamps.shift();
            }
            logError(`Exit ${exitCode}/${signal}`);
            if (crashTimestamps.push(now) > 4) {
              const msg = 'LSP crashed.';
              reportErrorStatus(msg);
              showErrorPrompt(msg, RESTART_LABEL, formatCorexId(SUB_RESTART));
              return;
            }
            const delay = 250 * 2 ** (crashTimestamps.length - 1);
            setStatus('sync~spin', `Retry in ${delay} ms…`);
            clearTimer(crashTimer);
            crashTimer = setTimer(() => {
              crashTimer = undefined;
              if (!isDeactivated) {
                runDetached(reconcileSession());
              }
            }, delay);
          },
          onProtocolError: logWarn,
          onPublishDiagnostics: (params: LspPublishDiagnosticsParams) => {
            if (activeClient === client) {
              const targetUri = VsUri.parse(params.uri);
              const canonicalUri = targetUri.toString();
              pullResultIds.delete(canonicalUri);
              const knownVer = openDocVersions.get(canonicalUri);
              if (
                knownVer !== undefined &&
                (params.version === undefined || params.version >= knownVer)
              ) {
                diagnosticCollection?.set(targetUri, toVsDiagnostics(params.diagnostics));
              }
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

        const readyBanner = `LSP v${client.initializeResult.serverInfo?.version ?? '0.1.0'}${isInternalCore ? ` [${INTERNAL_CORE_FLAG}]` : ''}`;
        setStatus('check', readyBanner);
        logInfo(readyBanner);
        return client;
      } catch (error: unknown) {
        if (!isDeactivated && gen === sessionGen) {
          reportErrorStatus('LSP failed.', error);
        }
        return undefined;
      }
    }

    return launchSession();
  })();
  return sessionPromise;
}

/** Triggers a detached fresh session reconciliation. */
function triggerFreshReconcile(): void {
  runDetached(reconcileSession(1));
}

/** Starts or restarts `corex lsp` on user command, warning if the workspace is untrusted. */
function restartFromCommand(): Promise<LspClientSession | undefined> | undefined {
  if (!vsWorkspace.isTrusted) {
    runDetached(vsWindow.showWarningMessage('Grant Workspace Trust to run CoreX.'));
    return undefined;
  }
  return reconcileSession(1);
}

/** Stops any running `corex lsp` server until restarted by the user or configuration change. */
function stopServerManually(): Promise<LspClientSession | undefined> | undefined {
  return vsWorkspace.isTrusted ? reconcileSession(2) : undefined;
}

/** Toggles `corex.inlayHints.enable` in user configuration. */
function toggleInlayHintsCommand(): Thenable<void> {
  return vsWorkspace
    .getConfiguration(COREX_CONFIG_SECTION)
    .update(INLAY_HINTS_KEY, !readExtensionConfig().isInlayHintsEnabled, true);
}

/**
 * Subscribes to `target.onDid<name>` (`'#'` expands to `'TextDocument'`).
 *
 * @param target     VS Code `workspace`, `window`, or `FileSystemWatcher` event source.
 * @param name       Event suffix under `onDid` (`'#'` = `'TextDocument'`).
 * @param listener   Event callback.
 */
function subscribeDidEvent<T>(
  target: unknown,
  name: string,
  listener: (event: T) => unknown
): Disposable {
  return (target as Record<string, (cb: (event: T) => unknown) => Disposable>)[
    `onDid${name.replace('~', 'Change').replace('#', `Text${DOC_WORD}`)}`
  ]?.(listener) as Disposable;
}

// --------------------- Editor Decorations ---------------------

/**
 * Creates a single-line `Range` spanning `[colStart, colStart + spanLen)` on `lineIdx`.
 *
 * @param lineIdx    Zero-based line index.
 * @param colStart   Zero-based inclusive start column.
 * @param spanLen    Code-unit span length (`0` when omitted).
 */
function createLineRange(lineIdx: number, colStart: number, spanLen = 0): Range {
  return new VsRange(lineIdx, colStart, lineIdx, colStart + spanLen);
}

/**
 * Computes and applies `stripGuideDecoration` and `mutedDimDecoration` across `editor.visibleRanges`.
 *
 * @param editor   Visible CoreX text editor (`languageId === 'corex'`).
 */
function updateEditorDecorations(editor: TextEditor): void {
  const { document, visibleRanges } = editor;
  if (isDeactivated || document.languageId !== COREX_CONFIG_SECTION) {
    return;
  }
  if (!stripGuideDecoration) {
    [stripGuideDecoration, mutedDimDecoration] = mapList(
      [
        {
          borderColor: new VsThemeColor('editorIndentGuide.activeBackground1'),
          borderStyle: 'solid',
          borderWidth: '0 0 0 1px',
        },
        { opacity: '0.58' },
      ],
      (options) => vsWindow.createTextEditorDecorationType(options)
    ) as [TextEditorDecorationType, TextEditorDecorationType];
  }

  const stripRanges: Range[] = [];
  const mutedRanges: Range[] = [];
  const lastDocLine = document.lineCount - 1;
  let prevVisEnd = -1;
  let scannedCount = 0;

  /** Scans non-comment, non-string tokens on `lineText` from `startCol`. */
  function scanCodeTokens(
    lineText: string,
    lineIdx: number,
    startCol: number,
    isEmittable: boolean
  ): string | undefined {
    if (!startCol && isEmittable && PURE_DISCARD_RX.test(lineText)) {
      const startIdx = lineText.indexOf('_');
      mutedRanges.push(createLineRange(lineIdx, startIdx, lineText.indexOf(';') + 1 - startIdx));
      return undefined;
    }

    LINE_TOKEN_RX.lastIndex = startCol;
    for (
      let tokMatch = LINE_TOKEN_RX.exec(lineText);
      tokMatch;
      tokMatch = LINE_TOKEN_RX.exec(lineText)
    ) {
      if (tokMatch[2]) {
        return tokMatch[1] ?? '';
      }
      if (tokMatch[3]) {
        const closeDelim = `"${tokMatch[4]}`;
        const closeIdx = lineText.indexOf(closeDelim, LINE_TOKEN_RX.lastIndex);
        LINE_TOKEN_RX.lastIndex = closeIdx === -1 ? lineText.length : closeIdx + closeDelim.length;
      } else if (tokMatch[5] && isEmittable) {
        mutedRanges.push(createLineRange(lineIdx, tokMatch.index, tokMatch[5].length));
      }
    }
    return undefined;
  }

  for (const visibleRange of visibleRanges) {
    const visEnd = Math.min(lastDocLine, visibleRange.end.line);
    const emitStart = Math.max(visibleRange.start.line, prevVisEnd + 1);
    const scanEnd = Math.min(lastDocLine, visEnd + 256);
    let openLine = -1;
    let openHashes = '';

    for (
      let lineIdx = Math.max(0, visibleRange.start.line - 256);
      lineIdx <= scanEnd && scannedCount < 4096;
      lineIdx += 1
    ) {
      scannedCount += 1;
      const lineText = document.lineAt(lineIdx).text;
      let colIdx = 0;

      if (openLine >= 0) {
        const closeMatch = CLOSE_MULTILINE_RX.exec(lineText);
        if (closeMatch?.[2] === openHashes) {
          const colC = (closeMatch[1] as string).length;
          if (colC > 0 && lineIdx - openLine <= 256) {
            for (
              let innerIdx = Math.max(openLine + 1, emitStart);
              innerIdx < lineIdx && innerIdx <= visEnd;
              innerIdx += 1
            ) {
              if (document.lineAt(innerIdx).text.length >= colC) {
                stripRanges.push(createLineRange(innerIdx, colC));
              }
            }
          }
          openLine = -1;
          colIdx = closeMatch[0].length;
        }
      }

      if (openLine < 0) {
        const nextHashes = scanCodeTokens(
          lineText,
          lineIdx,
          colIdx,
          lineIdx >= emitStart && lineIdx <= visEnd
        );
        if (nextHashes !== undefined) {
          openLine = lineIdx;
          openHashes = nextHashes;
        }
      }
    }
    prevVisEnd = Math.max(prevVisEnd, visEnd);
  }

  editor.setDecorations(stripGuideDecoration, stripRanges);
  editor.setDecorations(mutedDimDecoration as TextEditorDecorationType, mutedRanges);
}

/** Schedules a `35 ms` debounced decoration pass across all visible `.cx` editors. */
function scheduleDecorations(): void {
  if (!isDeactivated) {
    clearTimer(decorationTimer);
    decorationTimer = setTimer(() => {
      decorationTimer = undefined;
      const editors = vsWindow.visibleTextEditors;
      for (const editor of editors?.[0] ? editors : [vsWindow.activeTextEditor]) {
        if (editor) {
          updateEditorDecorations(editor);
        }
      }
    }, 35);
  }
}

// ------------------------------------- PUBLIC API --------------------------------------

/**
 * Activates the CoreX VS Code extension (`onLanguage:corex`, `workspaceContains:corex.toml`).
 *
 * @param context   VS Code extension host lifecycle context.
 */
export function activate(context: ExtensionContext): void {
  isDeactivated = false;
  diagnosticCollection = languages.createDiagnosticCollection(COREX_CONFIG_SECTION);
  inlayHintsEmitter = new EventEmitter<void>();
  const watcher = vsWorkspace.createFileSystemWatcher('**/{*.cx,corex.toml,corex.lock}');

  context.subscriptions.push(
    ...mapList(
      [
        [SUB_OUTPUT, showOutputChannel],
        [SUB_RESTART, restartFromCommand],
        [SUB_STOP, stopServerManually],
        [
          SUB_STATUS,
          () => {
            const [client, lspStatus, fmtStatus, hintsStatus, toggleLabel] = describeServices();
            return vsWindow
              .showQuickPick(
                mapList(
                  [
                    [LSP_SERVICE_LABEL],
                    [`$(output) ${SHOW_OUTPUT_LABEL}`, showOutputChannel, lspStatus],
                    [`$(refresh) ${RESTART_LABEL} ${LANG_SERVER_TEXT}`, restartFromCommand],
                    [
                      `$(${client ? 'stop' : 'play'}-circle) ${toggleLabel} ${LANG_SERVER_TEXT}`,
                      client ? stopServerManually : restartFromCommand,
                    ],
                    [`$(eye) ${INLAY_HINTS_LABEL}`, toggleInlayHintsCommand, hintsStatus],
                    [FMT_SERVICE_LABEL],
                    [
                      '$(wand) Format',
                      () => execVsCmd(`editor.action.format${DOC_WORD}`),
                      fmtStatus,
                    ],
                    [
                      `$(gear) ${SETTINGS_LABEL}`,
                      () => execVsCmd(CMD_OPEN_SETTINGS, COREX_CONFIG_SECTION),
                    ],
                  ] as readonly (readonly [string, (() => unknown)?, string?])[],
                  ([label, action, description]): StatusMenuEntry => ({
                    action,
                    description,
                    kind: (action ? 0 : -1) as QuickPickItemKind,
                    label,
                  })
                ),
                { title: 'CoreX' }
              )
              .then((pickedItem) => pickedItem?.action?.());
          },
        ],
        [SUB_HINTS, toggleInlayHintsCommand],
      ] as const,
      ([subCmd, handler]) => commands.registerCommand(formatCorexId(subCmd), handler)
    ),
    subscribeDidEvent(vsWindow, '~ActiveTextEditor', scheduleDecorations),
    subscribeDidEvent<{ readonly textEditor: TextEditor }>(
      vsWindow,
      '~TextEditorVisibleRanges',
      ({ textEditor }) =>
        textEditor.document.languageId === COREX_CONFIG_SECTION && scheduleDecorations()
    ),
    subscribeDidEvent<TextDocument>(vsWorkspace, 'Open#', (document) =>
      withRunningDoc(document, (client, uri) => syncOpenedDoc(client, document, uri))
    ),
    subscribeDidEvent<{
      readonly contentChanges: readonly { readonly range: Range; readonly text: string }[];
      readonly document: TextDocument;
    }>(vsWorkspace, '~#', ({ contentChanges, document }) => {
      if (contentChanges[0]) {
        if (document.languageId === COREX_CONFIG_SECTION) {
          scheduleDecorations();
        }
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
    subscribeDidEvent<TextDocument>(vsWorkspace, 'Close#', closeTrackedDoc),
    subscribeDidEvent(vsWorkspace, 'GrantWorkspaceTrust', triggerFreshReconcile),
    subscribeDidEvent(
      vsWorkspace,
      '~WorkspaceFolders',
      () => vsWorkspace.isTrusted && triggerFreshReconcile()
    ),
    subscribeDidEvent<{ readonly affectsConfiguration: (section: string) => boolean }>(
      vsWorkspace,
      '~Configuration',
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
            syncFormatProviders();
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
    ...mapList(['Create', '~', 'Delete'] as const, (evName, idx) =>
      subscribeDidEvent<Uri>(watcher, evName, (uri) => {
        const changeType = (idx + 1) as LspFileChangeType;
        const canonicalUri = uri.toString();
        if (
          isDeactivated ||
          !isCorexActive() ||
          uri.scheme !== 'file' ||
          !isValidUri(canonicalUri) ||
          IGNORED_PATH_RX.test(vsWorkspace.asRelativePath(uri, false))
        ) {
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
          if (client && pendingWatchedEvents.size) {
            client.notify('workspace/didChangeWatchedFiles', {
              changes: mapList([...pendingWatchedEvents], ([watchedUri, type]) => ({
                type,
                uri: watchedUri,
              })),
            });
            refreshSiblingDocs();
          }
          pendingWatchedEvents.clear();
        }, 75);
      })
    ),
    watcher
  );

  scheduleDecorations();
  triggerFreshReconcile();
}

/** Cleanly shuts down `corex lsp` and disposes all extension host resources. */
export async function deactivate(): Promise<void> {
  isDeactivated = true;
  isManuallyStopped = false;
  clearTimer(decorationTimer);
  clearTimer(watcherTimer);
  await reconcileSession();
  disposeList(lspProviderSubs);
  disposeList(formatProviderSubs);
  for (const item of [
    stripGuideDecoration,
    mutedDimDecoration,
    statusBarItem,
    inlayHintsEmitter,
    diagnosticCollection,
  ]) {
    item?.dispose();
  }
  [lastStatusState, stripGuideDecoration, mutedDimDecoration, statusBarItem] = [] as undefined[];
  pendingWatchedEvents.clear();
  crashTimestamps.length = 0;
  disposeLogger();
}

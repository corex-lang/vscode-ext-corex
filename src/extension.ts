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
  window,
  workspace,
  WorkspaceEdit,
} from 'vscode';
import type {
  CancellationToken,
  CodeActionContext,
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
  ReferenceContext,
  StatusBarAlignment,
  StatusBarItem,
  SymbolKind,
  SymbolTag,
  TextDocument,
} from 'vscode';
import { isInternalCoreEnabled, pathDirname, resolveCorexBinary } from '@/binary';
import {
  computeMinimalUtf16Edit,
  hasArrayProp,
  INTERNAL_CORE_FLAG,
  isArray,
  isJsonRpcRequestError,
  isRecord,
  isStr,
  isValidUri,
  LSP_REQUEST_CANCELED,
  LSP_SERVER_CANCELED,
  notifyTextDocument,
  runCorexFmtCli,
  startLspClient,
} from '@/client';
import {
  COREX_CONFIG_SECTION,
  hasServerRestartConfigChange,
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
} from '@/utils/logger';

// ---------------------------------------- TYPES ----------------------------------------

/** Status-bar Codicon identifier (`check`, `sync~spin`, `warning`, `error`). */
type StatusIcon = 'check' | 'sync~spin' | 'warning' | 'error';

/** Error handling policy for `requestLsp` (`0 = swallow`, `1 = Busy on -32802`, `2 = rethrow RPC`). */
type QueryErrorMode = 0 | 1 | 2;

// --------------------------------------- CONSTS ----------------------------------------

/** Local alias binding `languages` to a mangleable identifier. */
const vsLanguages = languages;

/** Local alias binding `workspace` to a mangleable identifier. */
const vsWorkspace = workspace;

/** Local alias binding `window` to a mangleable identifier. */
const vsWindow = window;

/** Local alias binding `commands` to a mangleable identifier. */
const vsCommands = commands;

/** Local alias binding `Uri` to a mangleable identifier. */
const VsUri = Uri;

/** Local alias binding `TextEdit` to a mangleable identifier. */
const VsTextEdit = TextEdit;

/** Local alias binding `CodeActionKind.QuickFix`. */
const QUICK_FIX_KIND = CodeActionKind.QuickFix;

/** Document selector matching local `file:` CoreX documents (`untitled:` excluded). */
const COREX_SELECTOR: DocumentSelector = { language: 'corex', scheme: 'file' };

/** Debounce interval for `FileSystemWatcher` batching (ms). */
const WATCHER_DEBOUNCE_DELAY = 75;

/** Maximum automatic `corex lsp` restarts permitted inside `CRASH_WINDOW_DURATION`. */
const MAX_CRASH_RESTARTS = 4;

/** Sliding window duration for the crash supervisor (ms; 60 s). */
const CRASH_WINDOW_DURATION = 60_000;

/** Base backoff delay before the first automatic crash restart (ms). */
const BASE_CRASH_BACKOFF_DELAY = 250;

/** Maximum entries retained in `pullResultIds` and `pendingWatchedEvents`. */
const MAX_BOUNDED_URI_CACHE_ENTRIES = 512;

/** Command ID opening the `CoreX` output channel. */
const CMD_SHOW_OUTPUT = 'corex.showOutputChannel';

/** Command ID restarting `corex lsp`. */
const CMD_RESTART = 'corex.restartServer';

/** Error message required when `prepareRename` rejects a non-renameable token. */
const CANNOT_RENAME_MSG = 'This symbol cannot be renamed.';

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
    document.languageId === 'corex' &&
    document.uri.scheme === 'file' &&
    isValidUri(document.uri.toString())
  );
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
    handler(client, document.uri.toString());
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
      lspFolders.push({ name: folder.name, uri: folder.uri.toString() });
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
  cache.delete(uri);
  if (cache.size >= MAX_BOUNDED_URI_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(uri, value);
}

/**
 * Updates (and lazily creates) the `CoreX` status-bar indicator using monochrome Codicons.
 *
 * @param icon      Codicon identifier (`'check'`, `'sync~spin'`, `'warning'`, `'error'`).
 * @param tooltip   Detailed hover tooltip text.
 */
function setStatus(icon: StatusIcon, tooltip: string): void {
  if (isDeactivated) {
    return;
  }
  statusBarItem ??= Object.assign(vsWindow.createStatusBarItem(2 as StatusBarAlignment, 100), {
    command: CMD_SHOW_OUTPUT,
    name: 'CoreX',
  });
  statusBarItem.text = `$(${icon}) CoreX`;
  statusBarItem.backgroundColor =
    icon === 'error' || icon === 'warning'
      ? new ThemeColor(`statusBarItem.${icon}Background`)
      : undefined;
  statusBarItem.tooltip = tooltip;
  statusBarItem.show();
}

// ------------------------ Type Mappers ------------------------

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
 * Coerces an untrusted numeric field into a clamped non-negative integer (`0` on `NaN`).
 *
 * @param rawNum   Untrusted numeric coordinate or index.
 */
function toNonNegInt(rawNum: unknown): number {
  return Math.max(0, Math.trunc(Number(rawNum)) || 0);
}

/**
 * Shifts a 1-based LSP enum value (`1..maxZero + 1`) to a clamped 0-based VS Code enum (`0..maxZero`).
 *
 * @param oneBased   1-based LSP integer discriminant.
 * @param maxZero    Maximum valid 0-based target discriminant.
 */
function shiftEnum(oneBased: number, maxZero: number): number {
  return Math.min(maxZero, toNonNegInt(Math.trunc(oneBased) - 1));
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
  if (!tags) {
    return undefined;
  }
  const valid: T[] = [];
  for (const tag of tags) {
    if (tag === 1 || tag === maxTag) {
      valid.push(tag as T);
    }
  }
  return valid.length > 0 ? valid : undefined;
}

/**
 * Converts a slice of `LspDiagnostic` items into `Diagnostic[]`.
 *
 * @param items   LSP diagnostics for a single document.
 */
function toVsDiagnostics(items: readonly LspDiagnostic[]): Diagnostic[] {
  return mapList(items, (lspDiag) => {
    const diag = new Diagnostic(
      toVsRange(lspDiag.range),
      lspDiag.message,
      shiftEnum(lspDiag.severity ?? 1, 3) as DiagnosticSeverity
    );
    diag.source = lspDiag.source ?? 'corex';
    diag.code = lspDiag.code;
    diag.tags = pickTags<DiagnosticTag>(lspDiag.tags, 2);
    diag.relatedInformation =
      lspDiag.relatedInformation &&
      mapList(
        lspDiag.relatedInformation,
        (relInfo) =>
          new DiagnosticRelatedInformation(toVsLocation(relInfo.location), relInfo.message)
      );
    return diag;
  });
}

/**
 * Narrows and converts an untrusted `definition` / `typeDefinition` payload.
 *
 * @param rawValue   Untrusted location payload.
 */
function mapLocations(rawValue: unknown): Location | Location[] | null {
  if (isArray(rawValue)) {
    return mapList(rawValue as readonly LspLocation[], toVsLocation);
  }
  return isRecord(rawValue) && isValidUri(rawValue.uri)
    ? toVsLocation(rawValue as unknown as LspLocation)
    : null;
}

/**
 * Recursively converts an `LspDocumentSymbol` tree into a `DocumentSymbol` tree.
 *
 * @param rawSym   Hierarchical LSP document symbol node.
 */
function toVsDocSymbol(rawSym: LspDocumentSymbol): DocumentSymbol {
  const sym = new DocumentSymbol(
    rawSym.name,
    rawSym.detail ?? '',
    shiftEnum(rawSym.kind, 25) as SymbolKind,
    toVsRange(rawSym.range),
    toVsRange(rawSym.selectionRange)
  );
  sym.tags = pickTags<SymbolTag>(rawSym.tags);
  if (rawSym.children?.length) {
    sym.children = mapList(rawSym.children, toVsDocSymbol);
  }
  return sym;
}

/**
 * Narrows `string | LspMarkupContent` into `string | MarkdownString | undefined`.
 *
 * @param docVal   Untrusted documentation block.
 */
function toVsDoc(docVal: unknown): string | MarkdownString | undefined {
  if (isStr(docVal)) {
    return docVal;
  } else if (isRecord(docVal) && isStr(docVal.value)) {
    return docVal.kind === 'markdown' ? new MarkdownString(docVal.value) : docVal.value;
  }
  return undefined;
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
  for (const [uri, edits] of Object.entries(changes ?? {})) {
    if (isValidUri(uri) && isArray(edits)) {
      edit.set(VsUri.parse(uri), mapList(edits as readonly LspTextEdit[], toVsEdit));
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
  uri = document.uri.toString()
): void {
  if (
    notifyTextDocument(client, 'didOpen', uri, {
      languageId: 'corex',
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
  const uri = document.uri.toString();
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
    if (!token.isCancellationRequested) {
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
        `textDocument/${subMethod}`,
        { ...extra, textDocument: { uri: document.uri.toString() } },
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
 * Handles inbound `textDocument/publishDiagnostics`, dropping closed-tab and stale-version frames.
 *
 * @param params   Inbound `publishDiagnostics` notification payload.
 */
function handlePublishDiagnostics(params: LspPublishDiagnosticsParams): void {
  const targetUri = VsUri.parse(params.uri);
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
          .request('textDocument/diagnostic', {
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

/** Synchronizes `DocumentFormattingEditProvider` and `DocumentRangeFormattingEditProvider` registrations. */
function syncFormatProviders(): void {
  disposeList(formatProviderSubs);
  const cfg = readExtensionConfig();
  if (!isCorexActive() || !cfg.isFormatEnabled) {
    return;
  }

  formatProviderSubs.push(
    vsLanguages.registerDocumentFormattingEditProvider(COREX_SELECTOR, {
      async provideDocumentFormattingEdits(document, options, token) {
        if (!isCorexActive() || !isCorexFileDoc(document)) {
          return null;
        }
        const latestCfg = readExtensionConfig();
        if (latestCfg.isLspEnabled) {
          const edits = await queryDoc(
            document,
            'formatting',
            { options },
            token,
            buildListMapper(toVsEdit)
          );
          if (edits || token.isCancellationRequested || getRunningClient()) {
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
        const minimalDiff = computeMinimalUtf16Edit(originalText, formattedText);
        return appendLfEdit(document, minimalDiff ? [toVsEdit(minimalDiff)] : []);
      },
    })
  );

  if (cfg.isLspEnabled) {
    formatProviderSubs.push(
      vsLanguages.registerDocumentRangeFormattingEditProvider(COREX_SELECTOR, {
        provideDocumentRangeFormattingEdits: (document, range, options, token) =>
          queryDoc(
            document,
            'rangeFormatting',
            { options, range: toLspRange(range) },
            token,
            buildListMapper(toVsEdit)
          ),
      })
    );
  }
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
  const semProvider = {
    provideDocumentRangeSemanticTokens: (
      document: TextDocument,
      range: Range,
      token: CancellationToken
    ) =>
      queryDoc(
        document,
        'semanticTokens/range',
        { range: toLspRange(range) },
        token,
        mapSemTokens,
        1
      ),
    provideDocumentSemanticTokens: (document: TextDocument, token: CancellationToken) =>
      queryDoc(document, 'semanticTokens/full', {}, token, mapSemTokens, 1),
    provideDocumentSemanticTokensEdits: (
      document: TextDocument,
      previousResultId: string,
      token: CancellationToken
    ) =>
      queryDoc(
        document,
        'semanticTokens/full/delta',
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
            : mapSemTokens(rawValue),
        1
      ),
  };

  lspProviderSubs.push(
    vsLanguages.registerDocumentSemanticTokensProvider(COREX_SELECTOR, semProvider, legend),
    vsLanguages.registerDocumentRangeSemanticTokensProvider(COREX_SELECTOR, semProvider, legend),
    vsLanguages.registerHoverProvider(COREX_SELECTOR, {
      provideHover: (document, position, token) =>
        queryPos(document, 'hover', position, token, (rawValue) => {
          if (!isRecord(rawValue)) {
            return null;
          }
          const content = toVsDoc(rawValue.contents);
          return content === undefined ? null : new Hover(content, tryVsRange(rawValue.range));
        }),
    }),
    vsLanguages.registerDefinitionProvider(COREX_SELECTOR, {
      provideDefinition: (document, position, token) =>
        queryPos(document, 'definition', position, token, mapLocations),
    }),
    vsLanguages.registerTypeDefinitionProvider(COREX_SELECTOR, {
      provideTypeDefinition: (document, position, token) =>
        queryPos(document, 'typeDefinition', position, token, mapLocations),
    }),
    vsLanguages.registerDocumentHighlightProvider(COREX_SELECTOR, {
      provideDocumentHighlights: (document, position, token) =>
        queryPos(
          document,
          'documentHighlight',
          position,
          token,
          buildListMapper(
            (hit: LspDocumentHighlight) =>
              new DocumentHighlight(
                toVsRange(hit.range),
                shiftEnum(hit.kind ?? 1, 2) as DocumentHighlightKind
              )
          )
        ),
    }),
    vsLanguages.registerReferenceProvider(COREX_SELECTOR, {
      provideReferences: (document, position, refContext: ReferenceContext, token) =>
        queryPos(document, 'references', position, token, buildListMapper(toVsLocation), {
          context: { includeDeclaration: refContext.includeDeclaration },
        }),
    }),
    vsLanguages.registerDocumentSymbolProvider(COREX_SELECTOR, {
      provideDocumentSymbols: (document, token) =>
        queryDoc(document, 'documentSymbol', {}, token, buildListMapper(toVsDocSymbol)),
    }),
    vsLanguages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols: (query, token) =>
        requestLsp(
          'workspace/symbol',
          { query },
          token,
          buildListMapper((rawSym: LspSymbolInformation) => {
            const symInfo = new SymbolInformation(
              rawSym.name,
              shiftEnum(rawSym.kind, 25) as SymbolKind,
              rawSym.containerName ?? '',
              toVsLocation(rawSym.location)
            );
            symInfo.tags = pickTags<SymbolTag>(rawSym.tags);
            return symInfo;
          })
        ),
    }),
    vsLanguages.registerCompletionItemProvider(
      COREX_SELECTOR,
      {
        provideCompletionItems: (document, position, token) =>
          queryPos(document, 'completion', position, token, (rawValue) => {
            const rawItems = hasArrayProp(rawValue, 'items') ? rawValue.items : rawValue;
            return isArray(rawItems)
              ? new CompletionList(
                  mapList(rawItems as readonly LspCompletionItem[], (rawItem, i) => {
                    const item = new CompletionItem(
                      rawItem.label,
                      rawItem.kind ? (shiftEnum(rawItem.kind, 24) as CompletionItemKind) : undefined
                    );
                    item.sortText = String(i).padStart(4, '0');
                    item.detail = rawItem.detail;
                    item.documentation = toVsDoc(rawItem.documentation);
                    item.tags = pickTags<CompletionItemTag>(rawItem.tags);
                    item.insertText = rawItem.textEdit
                      ? rawItem.textEdit.newText
                      : rawItem.insertText;
                    if (rawItem.textEdit) {
                      item.range = toVsRange(rawItem.textEdit.range);
                    }
                    return item;
                  }),
                  Boolean(isRecord(rawValue) && rawValue.isIncomplete)
                )
              : null;
          }),
      },
      '.',
      '@',
      ':'
    ),
    vsLanguages.registerSignatureHelpProvider(
      COREX_SELECTOR,
      {
        provideSignatureHelp: (document, position, token) =>
          queryPos(document, 'signatureHelp', position, token, (rawValue) => {
            if (!hasArrayProp(rawValue, 'signatures')) {
              return null;
            }
            const help = new SignatureHelp();
            help.signatures = mapList(
              rawValue.signatures as readonly LspSignatureInformation[],
              (rawSig) => {
                const sig = new SignatureInformation(rawSig.label, toVsDoc(rawSig.documentation));
                if (rawSig.parameters !== undefined) {
                  sig.parameters = mapList(
                    rawSig.parameters,
                    (param) =>
                      new ParameterInformation(
                        param.label as string | [number, number],
                        toVsDoc(param.documentation)
                      )
                  );
                }
                sig.activeParameter = rawSig.activeParameter;
                return sig;
              }
            );
            help.activeSignature = toNonNegInt(rawValue.activeSignature);
            help.activeParameter = toNonNegInt(rawValue.activeParameter);
            return help;
          }),
      },
      { retriggerCharacters: [','], triggerCharacters: ['(', ',', '['] }
    ),
    vsLanguages.registerInlayHintsProvider(COREX_SELECTOR, {
      onDidChangeInlayHints: inlayHintsEmitter.event,
      provideInlayHints: (document, range, token) =>
        readExtensionConfig().isInlayHintsEnabled
          ? queryDoc(
              document,
              'inlayHint',
              { range: toLspRange(range) },
              token,
              buildListMapper((rawHint: LspInlayHint) => {
                const hint = new InlayHint(
                  toVsPos(rawHint.position),
                  rawHint.label,
                  rawHint.kind === 1 || rawHint.kind === 2
                    ? (rawHint.kind as InlayHintKind)
                    : undefined
                );
                hint.paddingLeft = rawHint.paddingLeft;
                hint.paddingRight = rawHint.paddingRight;
                hint.textEdits = rawHint.textEdits && mapList(rawHint.textEdits, toVsEdit);
                hint.tooltip = toVsDoc(rawHint.tooltip);
                return hint;
              })
            )
          : [],
    }),
    vsLanguages.registerCodeActionsProvider(
      COREX_SELECTOR,
      {
        provideCodeActions: (document, range, actionContext: CodeActionContext, token) =>
          queryDoc(
            document,
            'codeAction',
            {
              context: {
                diagnostics: mapList(actionContext.diagnostics, (vsDiag) => ({
                  code: isRecord(vsDiag.code)
                    ? (vsDiag.code.value as number | string)
                    : vsDiag.code,
                  message: vsDiag.message,
                  range: toLspRange(vsDiag.range),
                  severity: (vsDiag.severity + 1) as 1 | 2 | 3 | 4,
                  source: vsDiag.source,
                })),
                only: ['quickfix'],
              },
              range: toLspRange(range),
            },
            token,
            buildListMapper((rawAction: LspCodeAction) => {
              const action = new CodeAction(rawAction.title, QUICK_FIX_KIND);
              action.isPreferred = rawAction.isPreferred;
              action.diagnostics = rawAction.diagnostics && toVsDiagnostics(rawAction.diagnostics);
              action.edit = toVsWorkspaceEdit(rawAction.edit) ?? undefined;
              return action;
            })
          ),
      },
      { providedCodeActionKinds: [QUICK_FIX_KIND] }
    ),
    vsLanguages.registerRenameProvider(COREX_SELECTOR, {
      async prepareRename(document, position, token) {
        const prep = await queryPos(document, 'prepareRename', position, token, (rawValue) => {
          if (isRecord(rawValue) && isStr(rawValue.placeholder)) {
            const range = tryVsRange(rawValue.range);
            if (range) {
              return { placeholder: rawValue.placeholder, range };
            }
          }
          return null;
        });
        if (prep === null) {
          if (token.isCancellationRequested) {
            return undefined;
          }
          throw new Error(CANNOT_RENAME_MSG);
        }
        return prep;
      },
      provideRenameEdits: (document, position, newName, token) =>
        queryPos(document, 'rename', position, token, toVsWorkspaceEdit, { newName }, 2),
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
        choice === primaryButton
          ? vsCommands.executeCommand(commandId, ...(commandArg === undefined ? [] : [commandArg]))
          : choice && showOutputChannel()
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

/** Stops any running `corex lsp` client and clears open-document state. */
async function stopActiveSession(): Promise<void> {
  clearTimeout(crashTimer);
  crashTimer = undefined;
  const prevClient = activeClient;
  clearSessionTracking();
  if (prevClient !== undefined) {
    await prevClient.stop();
  }
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
  while (
    crashTimestamps.length > 0 &&
    (crashTimestamps[0] as number) < now - CRASH_WINDOW_DURATION
  ) {
    crashTimestamps.shift();
  }
  crashTimestamps.push(now);
  logError(`Exit (${exitCode}, ${signal})`);

  if (crashTimestamps.length > MAX_CRASH_RESTARTS) {
    const msg = 'CoreX LSP crashed.';
    setStatus('error', msg);
    showErrorPrompt(msg, 'Restart Server', CMD_RESTART);
    return;
  }

  const delay = BASE_CRASH_BACKOFF_DELAY * 2 ** (crashTimestamps.length - 1);
  setStatus('sync~spin', `Retry in ${delay} ms…`);
  clearTimeout(crashTimer);
  crashTimer = setTimeout(() => {
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
    showErrorPrompt(msg, 'Open Settings', 'workbench.action.openSettings', 'corex.executablePath');
  }
}

/**
 * Synchronizes providers and status bar against Workspace Trust and `corex.lsp.enable`.
 *
 * @param cfg   Current validated configuration snapshot.
 */
function hasActiveLspGate(cfg: ExtensionConfig): boolean {
  syncFormatProviders();
  if (isCorexActive() && cfg.isLspEnabled) {
    ensureLspProviders();
    return true;
  }
  disposeList(lspProviderSubs);
  if (!vsWorkspace.isTrusted) {
    setStatus('warning', 'CoreX: Untrusted.');
  } else if (!cfg.isEnabled) {
    statusBarItem?.hide();
  } else {
    setStatus('warning', cfg.isFormatEnabled ? 'CoreX: CLI fmt.' : 'CoreX: Off.');
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
    await stopActiveSession();
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
    for (const doc of vsWorkspace.textDocuments) {
      if (isCorexFileDoc(doc)) {
        openCxPaths.push(doc.uri.fsPath);
      }
    }
    const { binaryPath } = binaryRes;
    const isInternalCore = isInternalCoreEnabled(cfg.internalCore, workspaceDirs, openCxPaths);
    setStatus('sync~spin', 'CoreX: Starting…');
    logInfo(`Start (${binaryPath}) [internal=${isInternalCore}]`);

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
      for (const doc of vsWorkspace.textDocuments) {
        if (isCorexFileDoc(doc)) {
          syncOpenedDoc(client, doc);
        }
      }
      inlayHintsEmitter?.fire();

      const readyBanner = `CoreX LSP v${client.initializeResult.serverInfo?.version ?? '0.1.0'}${isInternalCore ? ` [${INTERNAL_CORE_FLAG}]` : ''}`;
      setStatus('check', `${readyBanner}\n${binaryPath}`);
      logInfo(`${readyBanner} (pid=${client.pid})`);
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

/** Reloads configuration, resets crash/binary guards, and reconciles the session. */
function reconcileFresh(): Promise<LspClientSession | undefined> {
  invalidateConfigCache();
  crashTimestamps.length = 0;
  lastMissingKey = undefined;
  return reconcileSession();
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

  clearTimeout(watcherTimer);
  watcherTimer = setTimeout(() => {
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
  }, WATCHER_DEBOUNCE_DELAY);
}

// ------------------------------------- PUBLIC API --------------------------------------

/**
 * Activates the CoreX VS Code extension (`onLanguage:corex`, `workspaceContains:corex.toml`).
 *
 * @param context   VS Code extension host lifecycle context.
 */
export function activate(context: ExtensionContext): void {
  isDeactivated = false;
  diagnosticCollection = vsLanguages.createDiagnosticCollection('corex');
  inlayHintsEmitter = new EventEmitter<void>();
  const watcher = vsWorkspace.createFileSystemWatcher('**/{*.cx,corex.toml,corex.lock}');

  context.subscriptions.push(
    vsCommands.registerCommand(CMD_SHOW_OUTPUT, () => showOutputChannel()),
    vsCommands.registerCommand(CMD_RESTART, () =>
      vsWorkspace.isTrusted
        ? reconcileFresh()
        : runDetached(vsWindow.showWarningMessage('Grant Workspace Trust to run CoreX.'))
    ),
    vsWorkspace.onDidOpenTextDocument((document) =>
      withRunningDoc(document, (client, uri) => {
        if (!openDocVersions.has(uri)) {
          syncOpenedDoc(client, document, uri);
        }
      })
    ),
    vsWorkspace.onDidChangeTextDocument((changeEvent) => {
      if (changeEvent.contentChanges.length > 0) {
        withRunningDoc(changeEvent.document, (client, uri) => {
          pullResultIds.delete(uri);
          if (!openDocVersions.has(uri)) {
            syncOpenedDoc(client, changeEvent.document, uri);
          } else if (
            notifyTextDocument(client, 'didChange', uri, {
              contentChanges: mapList(changeEvent.contentChanges, (change) => ({
                range: toLspRange(change.range),
                text: change.text,
              })),
              textDocument: { version: changeEvent.document.version },
            })
          ) {
            openDocVersions.set(uri, changeEvent.document.version);
          } else {
            closeTrackedDoc(changeEvent.document, client);
          }
        });
      }
    }),
    vsWorkspace.onDidSaveTextDocument((document) =>
      withRunningDoc(document, (client, uri) => {
        notifyTextDocument(client, 'didSave', uri, { text: document.getText() });
        refreshSiblingDocs(uri);
      })
    ),
    vsWorkspace.onDidCloseTextDocument((document) => closeTrackedDoc(document)),
    vsWorkspace.onDidGrantWorkspaceTrust(() => runDetached(reconcileFresh())),
    vsWorkspace.onDidChangeWorkspaceFolders(() => {
      if (vsWorkspace.isTrusted) {
        runDetached(reconcileFresh());
      }
    }),
    vsWorkspace.onDidChangeConfiguration((configEvent) => {
      if (!configEvent.affectsConfiguration(COREX_CONFIG_SECTION)) {
        return;
      }
      const prevConfig = readExtensionConfig();
      invalidateConfigCache();
      const nextConfig = readExtensionConfig();
      if (hasServerRestartConfigChange(prevConfig, nextConfig)) {
        runDetached(reconcileFresh());
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
      }
    }),
    watcher.onDidCreate((uri) => recordWatchedEvent(uri, 1)),
    watcher.onDidChange((uri) => recordWatchedEvent(uri, 2)),
    watcher.onDidDelete((uri) => recordWatchedEvent(uri, 3)),
    watcher
  );

  runDetached(reconcileFresh());
}

/** Cleanly shuts down `corex lsp` and disposes all extension host resources. */
export async function deactivate(): Promise<void> {
  isDeactivated = true;
  sessionGen += 1;
  clearTimeout(watcherTimer);
  watcherTimer = undefined;
  await sessionPromise.catch(() => undefined);
  await stopActiveSession();
  sessionPromise = Promise.resolve(undefined);
  disposeList(lspProviderSubs);
  disposeList(formatProviderSubs);
  statusBarItem?.dispose();
  inlayHintsEmitter?.dispose();
  diagnosticCollection?.dispose();
  statusBarItem = undefined;
  inlayHintsEmitter = undefined;
  diagnosticCollection = undefined;
  pendingWatchedEvents.clear();
  crashTimestamps.length = 0;
  disposeLogger();
}

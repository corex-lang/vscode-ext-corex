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
  commands as vsCmds,
  CompletionItem,
  CompletionList,
  Diagnostic,
  DiagnosticRelatedInformation,
  DocumentHighlight,
  DocumentSymbol,
  EventEmitter,
  Hover,
  InlayHint,
  languages as vsLangs,
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
import {
  assignProps,
  findProjectToml,
  isInternalCoreEnabled,
  noop,
  NOT_FOUND_REASON,
  numMax,
  numMin,
  pathDirname,
  resolveCorexBinary,
  splitCsv,
} from '@/binary';
import {
  clearTimer,
  hasArrayProp,
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
  withDocUri,
} from '@/client';
import {
  COREX_CONFIG_SECTION,
  EXEC_PATH_KEY,
  FORMAT_ENABLE_KEY,
  getCorexWorkspaceConfig,
  INLAY_HINTS_KEY,
  invalidateConfigCache,
  LSP_ENABLE_KEY,
  readCfgTuple,
} from '@/config';
import type { ExtensionConfigTuple } from '@/config';
import type {
  BinaryResolutionResult,
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

/** Status-bar Codicon identifier (`check-all`, `check`, `sync~spin`, `warning`, `error`, `circle-slash`). */
type StatusIcon = 'check' | 'check-all' | 'circle-slash' | 'error' | 'sync~spin' | 'warning';

/** Error handling policy for `requestLsp` (`0 = swallow`, `1 = Busy on -32802`, `2 = rethrow RPC`). */
type QueryErrorMode = 0 | 1 | 2;

/** Interactive item inside the CoreX status-bar QuickPick menu (`corex.showStatusMenu`). */
interface StatusMenuEntry extends QuickPickItem {
  /** Callback invoked when the user selects this menu entry. */
  readonly cb?: () => unknown;
}

// --------------------------------------- CONSTS ----------------------------------------

/** Local alias binding `Range` to a mangleable identifier. */
const VsRange = Range;

/** Local alias binding `TextEdit` to a mangleable identifier. */
const VsTextEdit = TextEdit;

/** Local alias binding `Uri` to a mangleable identifier. */
const VsUri = Uri;

/** Shared `'Language Server'` title fragment. */
const LANG_SERVER_TEXT = 'Language Server';

/** Shared status-bar Codicons and common UI labels. */
const [
  ICON_CHECK,
  ICON_OFF,
  ICON_SPIN,
  ICON_WARN,
  ICON_ERR,
  FILE_SCHEME,
  DOC_WORD,
  DISABLED_TEXT,
  UNTRUSTED_WORD,
  FMT_WORD,
  SHOW_OUTPUT_LABEL,
  RESTART_LABEL,
  SETTINGS_LABEL,
  INLAY_HINTS_LABEL,
] = splitCsv(
  'check,circle-slash,sync~spin,warning,error,file,Document,Disabled,Untrusted,Formatter,Show Output,Restart,Settings,Inlay Hints'
) as [
  StatusIcon,
  StatusIcon,
  StatusIcon,
  StatusIcon,
  StatusIcon,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

/** Canonical `corex.*` command IDs referenced in multiple UI surfaces. */
const [CMD_OUTPUT, CMD_RESTART, CMD_STOP, CMD_STATUS, CMD_HINTS, CMD_FMT] = splitCsv(
  'showOutputChannel,restartServer,stopServer,showStatusMenu,toggleInlayHints,toggleFormat'
).map((subCmd) => `${COREX_CONFIG_SECTION}.${subCmd}`) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

/** Local alias binding `CodeActionKind.QuickFix`. */
const QUICK_FIX_KIND = CodeActionKind.QuickFix;

/** Document selector matching local `file:` CoreX documents (`untitled:` excluded). */
const COREX_SELECTOR: DocumentSelector = { language: COREX_CONFIG_SECTION, scheme: FILE_SCHEME };

/** Built-in VS Code command opening Settings filtered by query. */
const CMD_OPEN_SETTINGS = 'workbench.action.openSettings';

/** Shared warning string when no `corex` binary was auto-discovered. */
const BINARY_NOT_FOUND_MSG = 'Binary not found.';

/** Shared `'SemanticTokens'` provider suffix. */
const SEM_TOKENS = 'SemanticTokens';

/** Shared three-per-em-padded middle-dot separator (`U+2004 U+00B7 U+2004`). */
const DOT_SEP = ' · ';

// ----------------------------------- REGEX PATTERNS ------------------------------------

/** Matches workspace-relative paths inside ignored build, VCS, or dependency directories. */
const IGNORED_PATH_RX = /(?:^|[\\/])(?:\.(?:corex|git)|build|node_modules|zig-out)(?:[\\/]|$)/;

/** Matches pure variable discard statements (`_ = ident;`) without side-effecting calls or projections. */
// oxlint-disable-next-line prefer-named-capture-group -- positional group avoids unmangleable group keys under 25 KB bundle budget
const PURE_DISCARD_RX = /^\s*(_\s*=\s*(?:[a-z][a-z0-9_]*|_\w+)\s*;)\s*(?:\/\/.*)?$/;

/** Matches standalone closing multiline string lines (`^[ ]*"#*`) without trailing identifier characters. */
// oxlint-disable-next-line prefer-named-capture-group -- positional groups avoid unmangleable group keys under 25 KB bundle budget
const CLOSE_MULTILINE_RX = /^( *)"(#*)(?!\w)/;

/** Matches comments, multiline string openers, single-line strings/chars, and `_unused` / word tokens. */
const LINE_TOKEN_RX = new RegExp(
  // oxlint-disable-next-line prefer-named-capture-group -- positional groups avoid unmangleable group keys under 25 KB bundle budget
  /\/(?:[/|#].*|\*.*?(?:\*\/|$))|(?:\b(?:(?:f|b?r)(#*)|b)|(?<![\w"#]))(")$|\b(f(?=#)|b?r)(#*)"|\bf"(?:\\.|[^"\\{]|\{\{|\{(?!\{)(?:@|\{(?:@|[^"{}'])*\}|[^"{}'])*\})*"?|(?:\bb)?(?:@|["'].*)|(_\w+)|\w+/.source.replaceAll(
    '@',
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/.source
  ),
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

/** Lazily created `[stripGuideDecoration, mutedDimDecoration]` pair for `.cx` editors. */
let editorDecos: readonly [TextEditorDecorationType, TextEditorDecorationType] | undefined =
  undefined;

/** Active timers indexed by slot: `[0 = decorations, 1 = crashRetry, 2 = fsWatcher]`. */
const activeTimers: (ReturnType<typeof setTimeout> | undefined)[] = [];

/** Last binary-missing key surfaced as a toast notification to avoid repeat spam. */
let lastMissingKey: string | undefined = undefined;

/** Last status-bar icon and summary headline used to refresh dynamic config toggles. */
let lastStatusState: readonly [StatusIcon, string] | undefined = undefined;

/** Resolved extension package version (`1.0.0` fallback in headless tests). */
let extVersion = '1.0.0';

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
 * Executes a VS Code command with an optional single argument.
 *
 * @param commandId    Command identifier to invoke.
 * @param commandArg   Optional command argument.
 */
function execVsCmd(commandId: string, commandArg?: unknown): Thenable<unknown> {
  return vsCmds.executeCommand(commandId, ...(commandArg === undefined ? [] : [commandArg]));
}

/**
 * Opens VS Code Settings filtered to `corex` (or `corex.<subKey>` when provided).
 *
 * @param subKey   Optional setting suffix under `corex.*`.
 */
function openCorexSettings(subKey?: unknown): Thenable<unknown> {
  return execVsCmd(
    CMD_OPEN_SETTINGS,
    isStr(subKey) && subKey ? `${COREX_CONFIG_SECTION}.${subKey}` : COREX_CONFIG_SECTION
  );
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
  promise.then(noop, noop);
}

/**
 * Cancels `activeTimers[slot]` and schedules `callback` after `delay` (ms) if not deactivated.
 *
 * @param slot       Timer slot (`0 = decorations`, `1 = crashRetry`, `2 = fsWatcher`).
 * @param delay      Debounce or backoff delay (ms).
 * @param callback   Deferred callback.
 */
function armTimer(slot: 0 | 1 | 2, delay: number, callback?: () => void): void {
  clearTimer(activeTimers[slot]);
  activeTimers[slot] =
    callback && !isDeactivated
      ? setTimer(() => {
          activeTimers[slot] = undefined;
          if (!isDeactivated) {
            callback();
          }
        }, delay)
      : undefined;
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

/** Returns `true` when the active VS Code workspace is trusted. */
function isWsTrusted(): boolean {
  return vsWorkspace.isTrusted;
}

/** Returns `true` when the workspace is trusted and `corex.enable` is `true`. */
function isCorexActive(): boolean {
  return isWsTrusted() && readCfgTuple()[0];
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
    document.uri.scheme === FILE_SCHEME &&
    isValidUri(readDocUri(document))
  );
}

/** Returns all currently open local `file:` CoreX `TextDocument` instances. */
function getOpenCxDocs(): TextDocument[] {
  return vsWorkspace.textDocuments.filter(isCorexFileDoc);
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

/** Returns all open local `file:` workspace folders. */
function getFileWsFolders(): readonly { readonly name: string; readonly uri: Uri }[] {
  return (vsWorkspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === FILE_SCHEME);
}

/**
 * Resolves the active `corex` binary, `--internal-core` flag, and workspace roots.
 *
 * @param fallbackFiles   Open `.cx` file paths consulted when no workspace folder is open.
 */
function resolveToolchain(
  fallbackFiles: readonly string[]
): readonly [BinaryResolutionResult, boolean, string[], LspWorkspaceFolder[]] {
  const cfg = readCfgTuple();
  const folders = getFileWsFolders();
  const workspaceDirs = folders.map((folder) => folder.uri.fsPath);
  return [
    resolveCorexBinary(cfg[4], { workspaceDirs }),
    isInternalCoreEnabled(cfg[5], workspaceDirs, fallbackFiles),
    workspaceDirs,
    folders.map((folder) => ({ name: folder.name, uri: readDocUri(folder) })),
  ];
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
 * Wraps an element mapper into an untrusted array validator returning `R[] | null`.
 *
 * @param mapper   Element conversion callback.
 */
function buildListMapper<T, R>(
  mapper: (item: T, index: number) => R
): (rawValue: unknown) => R[] | null {
  return (rawValue) => (isArray(rawValue) ? (rawValue as readonly T[]).map(mapper) : null);
}

/**
 * Returns `true` when `icon` represents an error or warning fault state.
 *
 * @param icon   Status-bar Codicon identifier.
 */
function isFaultIcon(icon?: StatusIcon): boolean {
  return icon === ICON_ERR || icon === ICON_WARN;
}

/**
 * Wraps `content` in `<span style="color:var(--vscode-<token>);">` outside High Contrast themes.
 *
 * @param content   Markdown or HTML fragment to tint.
 * @param token     VS Code CSS theme color variable suffix (`'descriptionForeground'` by default).
 */
function wrapThemeSpan(content: string, token = 'descriptionForeground'): string {
  return !token || (vsWindow.activeColorTheme?.kind ?? 2) > 2
    ? content
    : `<span style="color:var(--vscode-${token});">${content}</span>`;
}

/**
 * Formats a Markdown command link `[label](command:<cmdId>)`.
 *
 * @param label   Link display text.
 * @param cmdId   Full command identifier (`corex.*` or built-in).
 */
function buildCmdLink(label: string, cmdId: string): string {
  return `[${label}](command:${cmdId})`;
}

/**
 * Formats one status-popover service row (`$(icon) **Title[: detail]** [ • links]`).
 *
 * @param glyph    Codicon identifier.
 * @param title    Service name.
 * @param detail   Optional secondary state suffix.
 * @param color    Optional VS Code theme token suffix.
 * @param links    Optional Markdown action links.
 */
function renderSvcRow(
  glyph: string,
  title: string,
  detail: string,
  color: string,
  links?: string
): string {
  const head = wrapThemeSpan(`$(${glyph}) **${title}${detail ? `:** ${detail}` : '**'}`, color);
  return links ? `${head} • ${links}` : head;
}

/**
 * Summarizes `[client, fmtMode, lspDetail, hintsStatus]` for the status bar and menu.
 *
 * @param summary   Primary status headline.
 */
function describeServices(
  summary = 'Inactive'
): readonly [LspClientSession | undefined, string, string, string] {
  const cfg = readCfgTuple();
  const client = getRunningClient();
  let lspDetail = cfg[1] ? summary : DISABLED_TEXT;
  if (!isWsTrusted()) {
    lspDetail = UNTRUSTED_WORD;
  } else if (client) {
    lspDetail = `PID ${client.pid}`;
  } else if (isManuallyStopped) {
    lspDetail = 'Stopped';
  }
  return [
    client,
    isCorexActive() && cfg[2] ? ((client && 'LSP') ?? 'CLI') : '',
    lspDetail,
    cfg[3] ? 'On' : 'Off',
  ];
}

/**
 * Formats the per-service Markdown rows (`Language Server` and `Formatter`) for the hover popover.
 *
 * @param icon        Active status icon.
 * @param summary     Primary status headline.
 * @param isFault     Whether `icon` is `'error'` or `'warning'`.
 * @param client      Running `LspClientSession`, if any.
 * @param isFmtOn     Whether document formatting is active.
 * @param lspDetail   Fallback secondary status text.
 */
function buildSvcRows(
  icon: StatusIcon,
  summary: string,
  isFault: boolean,
  client: LspClientSession | undefined,
  isFmtOn: boolean,
  lspDetail: string
): string {
  const faultColor = isFault ? `editor${icon === ICON_ERR ? 'Error' : 'Warning'}-foreground` : '';
  const isSpin = icon === ICON_SPIN;
  let lspAct = isFault ? RESTART_LABEL : 'Start';
  if (isSpin) {
    lspAct = 'Stop';
  }
  const lspRow = client
    ? renderSvcRow(
        ICON_CHECK,
        LANG_SERVER_TEXT,
        '',
        '',
        `${buildCmdLink(RESTART_LABEL, CMD_RESTART)}${DOT_SEP}${buildCmdLink('Stop', CMD_STOP)}`
      )
    : renderSvcRow(
        isFault || isSpin ? icon : ICON_OFF,
        LANG_SERVER_TEXT,
        isSpin ? summary : lspDetail,
        faultColor,
        buildCmdLink(lspAct, isSpin ? CMD_STOP : CMD_RESTART)
      );
  const isUntrusted = !isWsTrusted();
  const fmtRow =
    isUntrusted || (isFault && isFmtOn && !summary.startsWith('LSP'))
      ? renderSvcRow(icon, FMT_WORD, isUntrusted ? UNTRUSTED_WORD : summary, faultColor)
      : renderSvcRow(
          isFmtOn ? ICON_CHECK : ICON_OFF,
          FMT_WORD,
          isFmtOn ? '' : DISABLED_TEXT,
          '',
          buildCmdLink(isFmtOn ? 'Disable' : 'Enable', CMD_FMT)
        );
  return `${lspRow}  \n${fmtRow}`;
}

/**
 * Updates (and lazily creates) the `CoreX` status-bar indicator using monochrome Codicons.
 *
 * @param icon      Requested status icon (`'check-all'`, `'check'`, `'sync~spin'`, `'warning'`, `'error'`, `'circle-slash'`).
 * @param summary   Concise status headline included in the dual-service hover tooltip.
 */
function setStatus(icon: StatusIcon, summary: string): void {
  if (isDeactivated) {
    return;
  }
  lastStatusState = [icon, summary];
  const [client, fmtMode, lspDetail, hintsStatus] = describeServices(summary);
  const isFmtOn = Boolean(fmtMode);
  const isFault = isFaultIcon(icon);
  const pillIcon =
    isFault || icon === ICON_SPIN
      ? icon
      : ([ICON_OFF, ICON_CHECK, 'check-all'] as const)[(client ? 1 : 0) + (isFmtOn ? 1 : 0)];
  const rowsMd = buildSvcRows(icon, summary, isFault, client, isFmtOn, lspDetail);
  const tooltip = assignProps(
    new MarkdownString(
      `**CoreX**${DOT_SEP}${summary} <sub>${wrapThemeSpan(`(ext v${extVersion})`)}</sub>\n\n${rowsMd}\n\n${buildCmdLink(`${INLAY_HINTS_LABEL}: ${hintsStatus}`, CMD_HINTS)}${DOT_SEP}${buildCmdLink(SETTINGS_LABEL, `${CMD_OPEN_SETTINGS}?%22${COREX_CONFIG_SECTION}%22`)}${DOT_SEP}${buildCmdLink('Output', CMD_OUTPUT)}`,
      true
    ),
    { isTrusted: true, supportHtml: true }
  );
  assignProps((statusBarItem ??= vsWindow.createStatusBarItem(2 as StatusBarAlignment, 100)), {
    backgroundColor: isFault ? new ThemeColor(`statusBarItem.${icon}Background`) : undefined,
    command: CMD_STATUS,
    text: `$(${pillIcon}) CoreX`,
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
  return numMax(0, Math.trunc(rawNum as number) || 0);
}

/**
 * Shifts a 1-based LSP enum value (`1..maxZero + 1`) to a clamped 0-based VS Code enum (`0..maxZero`).
 *
 * @param oneBased   1-based LSP integer discriminant.
 * @param maxZero    Maximum valid 0-based target discriminant.
 */
function shiftEnum(oneBased: number, maxZero: number): number {
  return numMin(maxZero, toNonNegInt(oneBased - 1));
}

/**
 * Wraps `range` into `{ range: LspRange }` (with optional Quick Fix `codeAction` context).
 *
 * @param range        VS Code UTF-16 range.
 * @param isQuickFix   Whether to attach `{ context: { only: [QuickFix] } }`.
 */
function toRangeParam(range: Range, isQuickFix?: boolean): Readonly<Record<string, unknown>> {
  return {
    range: { end: range.end, start: range.start },
    ...(isQuickFix && { context: { only: [QUICK_FIX_KIND] } }),
  };
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
  const valid = tags?.filter((tag) => tag === 1 || tag === maxTag) as T[] | undefined;
  return valid?.[0] && valid;
}

/**
 * Converts a slice of `LspDiagnostic` items into `Diagnostic[]`.
 *
 * @param items   LSP diagnostics for a single document.
 */
function toVsDiagnostics(items: readonly LspDiagnostic[]): Diagnostic[] {
  return items.map(
    ({
      code,
      message,
      range,
      relatedInformation,
      severity = 1,
      source = COREX_CONFIG_SECTION,
      tags,
    }) =>
      assignProps(
        new Diagnostic(toVsRange(range), message, shiftEnum(severity, 3) as DiagnosticSeverity),
        {
          code,
          relatedInformation: relatedInformation?.map(
            ({ location, message: relMsg }) =>
              new DiagnosticRelatedInformation(toVsLocation(location), relMsg)
          ),
          source,
          tags: pickTags<DiagnosticTag>(tags, 2),
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
function toVsDocSymbol({
  children,
  detail = '',
  kind,
  name,
  range,
  selectionRange,
  tags,
}: LspDocumentSymbol): DocumentSymbol {
  return assignProps(
    new DocumentSymbol(
      name,
      detail,
      shiftEnum(kind, 25) as SymbolKind,
      toVsRange(range),
      toVsRange(selectionRange)
    ),
    { children: children?.map(toVsDocSymbol) ?? [], tags: pickTags<SymbolTag>(tags) }
  );
}

/**
 * Narrows `string | LspMarkupContent` into `string | MarkdownString | undefined`, styling contract footers.
 *
 * @param docVal   Untrusted documentation block.
 */
function toVsDoc(docVal: unknown): string | MarkdownString | undefined {
  if (!isRecord(docVal) || !isStr(docVal.value)) {
    return readOptStr(docVal);
  }
  const rawMd = docVal.value;
  if (docVal.kind !== 'markdown') {
    return rawMd;
  }
  const splitAt = rawMd.lastIndexOf('\n\n---\n\n') + 7;
  const foot =
    splitAt > 6 && '✓⚠'.includes(rawMd[splitAt] as string)
      ? wrapThemeSpan(rawMd.slice(splitAt).replaceAll('\n\n', '<br>'))
      : '';
  return assignProps(
    new MarkdownString(foot ? `${rawMd.slice(0, splitAt)}<sub>${foot}</sub>` : rawMd),
    { supportHtml: true }
  );
}

/**
 * Validates and converts an untrusted `LspWorkspaceEdit` into a `WorkspaceEdit | null`.
 *
 * @param rawEdit   Untrusted workspace edit object.
 */
function toVsWorkspaceEdit(rawEdit: unknown): WorkspaceEdit | null {
  const changes = isRecord(rawEdit) ? rawEdit.changes : null;
  if (changes !== undefined && !isRecord(changes)) {
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
 * Publishes converted `items` into `diagnosticCollection` for `targetUri`.
 *
 * @param targetUri   Document `Uri` or canonical URI string.
 * @param items       Wire LSP diagnostics.
 */
function publishDocDiags(targetUri: Uri | string, items: readonly LspDiagnostic[]): void {
  diagnosticCollection?.set(
    isStr(targetUri) ? VsUri.parse(targetUri) : targetUri,
    toVsDiagnostics(items)
  );
}

/**
 * Records `document` in `openDocVersions` and sends `textDocument/didOpen` if `activeClient` is ready.
 *
 * @param document   Open `file:` CoreX document.
 */
function syncOpenedDoc(document: TextDocument): void {
  withRunningDoc(document, (client, uri) => {
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
  });
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
  token: CancellationToken | undefined,
  mapFn: (rawValue: unknown) => R | null,
  errMode: QueryErrorMode = 0
): Promise<R | null> {
  const client = isCorexActive() && readCfgTuple()[1] ? await sessionPromise : undefined;
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
 * @param token       Optional cancellation token.
 * @param mapFn       Validator and converter returning `R | null`.
 * @param errMode     Error propagation mode (`0 = null`, `1 = Busy`, `2 = rethrow RPC`).
 */
function queryDoc<R>(
  document: TextDocument,
  subMethod: string,
  extra: Readonly<Record<string, unknown>>,
  token: CancellationToken | undefined,
  mapFn: (rawValue: unknown) => R | null,
  errMode: QueryErrorMode = 0
): Promise<R | null> | null {
  return isCorexFileDoc(document)
    ? requestLsp(
        TEXT_DOC_PREFIX + subMethod,
        withDocUri(readDocUri(document), extra),
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
  return queryDoc(document, subMethod, { ...extra, position }, token, mapFn, errMode);
}

/**
 * Refreshes diagnostics across all currently open `.cx` tabs (optionally skipping `excludedUri`).
 *
 * @param excludedUri   Optional URI already updated by `didSave` push diagnostics.
 */
function refreshSiblingDocs(excludedUri?: string): void {
  const client = getRunningClient();
  for (const [uri, ver] of client ? openDocVersions : []) {
    if (client && uri !== excludedUri) {
      const reqParams = withDocUri(uri, { previousResultId: pullResultIds.get(uri) });
      runDetached(
        client.request(`${TEXT_DOC_PREFIX}diagnostic`, reqParams).then((report) => {
          if (isRecord(report) && activeClient === client && openDocVersions.get(uri) === ver) {
            if (isStr(report.resultId)) {
              putBounded(pullResultIds, uri, report.resultId);
            }
            if (report.kind === 'full' && isArray(report.items)) {
              publishDocDiags(uri, report.items as readonly LspDiagnostic[]);
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
  return (vsLangs as unknown as Record<string, (...rest: unknown[]) => Disposable>)[
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
 * Registers a position-based `textDocument/*` provider deriving its `camelCase` LSP method name from `kind`.
 *
 * @param kind    VS Code provider base name (`'#'` = `'Document'`, trailing `'*'` = plural `'s'`).
 * @param mapFn   Validator and converter returning `R | null`.
 * @param extra   Optional trailing registration arguments.
 */
function registerPosProvider<R>(
  kind: string,
  mapFn: (rawValue: unknown) => R | null,
  ...extra: unknown[]
): Disposable {
  const base = cleanProviderKind(kind).replace('Item', '');
  const subMethod = (base[0] as string).toLowerCase() + base.slice(1);
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
  const cfg = readCfgTuple();
  if (!isCorexActive() || !cfg[2]) {
    return;
  }

  formatProviderSubs.push(
    registerLangProvider(
      '#FormattingEdit*',
      async (document: TextDocument, options: unknown, token: CancellationToken) => {
        if (!isCorexActive() || !isCorexFileDoc(document)) {
          return null;
        }
        const edits =
          readCfgTuple()[1] &&
          (await queryDoc(document, 'formatting', { options }, token, mapEditList));
        if (edits || isCanceled(token) || getRunningClient()) {
          return edits ? appendLfEdit(document, edits) : null;
        }
        const [binaryRes, isInternalCore] = resolveToolchain([document.uri.fsPath]);
        if (!binaryRes.isFound) {
          logWarn(BINARY_NOT_FOUND_MSG);
          return null;
        }
        const originalText = document.getText();
        const formattedText = await runCorexFmtCli(
          binaryRes.binaryPath,
          originalText,
          isInternalCore,
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
    ...(cfg[1]
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
function showErrorPrompt(message: string, primaryButton: string, onPrimary: () => unknown): void {
  runDetached(
    vsWindow
      .showErrorMessage(message, primaryButton, SHOW_OUTPUT_LABEL)
      .then((choice) => (choice === primaryButton ? onPrimary() : choice && showOutputChannel()))
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
  setStatus(ICON_ERR, message);
  logError(message, error);
}

/**
 * Updates the status bar when `corex lsp` is intentionally inactive or gated by Workspace Trust.
 *
 * @param cfg   Current validated configuration tuple.
 */
function applyInactiveStatus(cfg: ExtensionConfigTuple): void {
  if (!isWsTrusted()) {
    setStatus(ICON_WARN, `${UNTRUSTED_WORD}.`);
  } else if (cfg[0]) {
    setStatus(
      isManuallyStopped ? ICON_OFF : ICON_CHECK,
      isManuallyStopped ? 'Stopped.' : (cfg[2] && 'Format only') || 'Off'
    );
  } else {
    statusBarItem?.hide();
  }
}

/**
 * Surfaces a missing or invalid `corex` binary on the status bar and deduplicated toast prompt.
 *
 * @param binaryRes        Missing binary resolution record.
 * @param configuredPath   Raw `corex.executablePath` setting value.
 */
function reportMissingBinary(binaryRes: BinaryResolutionResult, configuredPath: string): void {
  if (!binaryRes.isFound && binaryRes.reason === NOT_FOUND_REASON) {
    setStatus(ICON_WARN, BINARY_NOT_FOUND_MSG);
    logWarn(BINARY_NOT_FOUND_MSG);
  } else if (!binaryRes.isFound) {
    const candidate = binaryRes.configuredCandidate ?? configuredPath;
    const msg = `Missing: ${candidate}`;
    reportErrorStatus(msg);
    if (lastMissingKey !== candidate) {
      lastMissingKey = candidate;
      showErrorPrompt(msg, SETTINGS_LABEL, () => openCorexSettings(EXEC_PATH_KEY));
    }
  }
}

/**
 * Registers all LSP-backed VS Code language feature providers once `client` is initialized.
 *
 * @param client   Initialized `LspClientSession` supplying `semanticTokensProvider.legend`.
 */
function ensureLspProviders(client: LspClientSession): void {
  if (lspProviderSubs[0] || !inlayHintsEmitter) {
    return;
  }
  const srvLegend = client.initializeResult.capabilities.semanticTokensProvider?.legend;
  const legend = new SemanticTokensLegend(
    (srvLegend?.tokenTypes as string[] | undefined) ?? [],
    (srvLegend?.tokenModifiers as string[] | undefined) ?? []
  );
  const fullSemMethod = `provide${DOC_WORD}${SEM_TOKENS}`;
  lspProviderSubs.push(
    registerLangProvider(
      `#${SEM_TOKENS}`,
      {
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
                    (rawValue.edits as readonly LspSemanticTokensEdit[]).map(
                      ({ data, deleteCount, start }) =>
                        new SemanticTokensEdit(start, deleteCount, data && new Uint32Array(data))
                    ),
                    readOptStr(rawValue.resultId)
                  )
                : mapSemTokens(rawValue)
          ),
      },
      legend
    ),
    registerLangProvider(
      `#Range${SEM_TOKENS}`,
      (document: TextDocument, range: Range, token: CancellationToken) =>
        querySem(document, 'range', toRangeParam(range), token),
      legend
    ),
    registerPosProvider('Hover', (rawValue) => {
      const content = isRecord(rawValue) && toVsDoc(rawValue.contents);
      return content ? new Hover(content, tryVsRange(rawValue.range)) : null;
    }),
    ...['', 'Type'].map((prefix) =>
      registerPosProvider(
        `${prefix}Definition`,
        (rawValue) =>
          mapLocationList(rawValue) ??
          (isRecord(rawValue) && isValidUri(rawValue.uri)
            ? toVsLocation(rawValue as unknown as LspLocation)
            : null)
      )
    ),
    registerPosProvider(
      '#Highlight*',
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
        buildListMapper(
          ({ containerName = '', kind, location, name, tags }: LspSymbolInformation) =>
            assignProps(
              new SymbolInformation(
                name,
                shiftEnum(kind, 25) as SymbolKind,
                containerName,
                toVsLocation(location)
              ),
              { tags: pickTags<SymbolTag>(tags) }
            )
        )
      )
    ),
    registerPosProvider(
      'CompletionItem*',
      (rawValue) => {
        const rawItems = hasArrayProp(rawValue, 'items') ? rawValue.items : rawValue;
        return isArray(rawItems)
          ? new CompletionList(
              (rawItems as readonly LspCompletionItem[]).map(
                ({ detail, documentation, insertText, kind, label, tags, textEdit }, i) =>
                  assignProps(
                    new CompletionItem(
                      label,
                      kind ? (shiftEnum(kind, 24) as CompletionItemKind) : undefined
                    ),
                    {
                      detail,
                      documentation: toVsDoc(documentation),
                      insertText: textEdit?.newText ?? insertText,
                      range: textEdit && toVsRange(textEdit.range),
                      sortText: `${1e5 + i}`,
                      tags: pickTags<CompletionItemTag>(tags),
                    }
                  )
              ),
              Boolean((rawValue as { isIncomplete?: unknown }).isIncomplete)
            )
          : null;
      },
      ...'.@:'
    ),
    registerPosProvider(
      'SignatureHelp',
      (rawValue) =>
        hasArrayProp(rawValue, 'signatures')
          ? assignProps(new SignatureHelp(), {
              activeParameter: toNonNegInt(rawValue.activeParameter),
              activeSignature: toNonNegInt(rawValue.activeSignature),
              signatures: (rawValue.signatures as readonly LspSignatureInformation[]).map(
                ({ activeParameter, documentation, label, parameters = [] }) =>
                  assignProps(new SignatureInformation(label, toVsDoc(documentation)), {
                    activeParameter,
                    parameters: parameters.map(
                      ({ documentation: paramDoc, label: paramLabel }) =>
                        new ParameterInformation(
                          paramLabel as string | [number, number],
                          toVsDoc(paramDoc)
                        )
                    ),
                  })
              ),
            })
          : null,
      ...'(,['
    ),
    registerLangProvider('InlayHints', {
      onDidChangeInlayHints: inlayHintsEmitter.event,
      provideInlayHints: (document: TextDocument, range: Range, token: CancellationToken) =>
        readCfgTuple()[3]
          ? queryDoc(
              document,
              'inlayHint',
              toRangeParam(range),
              token,
              buildListMapper((rawHint: LspInlayHint) => {
                const pos = toVsPos(rawHint.position);
                return assignProps(new InlayHint(pos, rawHint.label), {
                  ...rawHint,
                  kind:
                    rawHint.kind === 1 || rawHint.kind === 2
                      ? (rawHint.kind as InlayHintKind)
                      : undefined,
                  position: pos,
                  textEdits: mapEditList(rawHint.textEdits) ?? undefined,
                  tooltip: toVsDoc(rawHint.tooltip),
                });
              })
            )
          : [],
    }),
    registerLangProvider(
      'CodeActions',
      (document: TextDocument, range: Range, _context: unknown, token: CancellationToken) =>
        queryDoc(
          document,
          'codeAction',
          toRangeParam(range, true),
          token,
          buildListMapper(({ diagnostics, edit, isPreferred, title }: LspCodeAction) =>
            assignProps(new CodeAction(title, QUICK_FIX_KIND), {
              diagnostics: diagnostics && toVsDiagnostics(diagnostics),
              edit: toVsWorkspaceEdit(edit) ?? undefined,
              isPreferred,
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
    await prevPromise.catch(noop);
    armTimer(1, 0);
    const prevClient = activeClient;
    clearSessionTracking();
    await prevClient?.stop();
    const cfg = readCfgTuple();
    if (isDeactivated || gen !== sessionGen) {
      return undefined;
    }
    syncFormatProviders();
    if (!isCorexActive() || !cfg[1] || isManuallyStopped) {
      disposeList(lspProviderSubs);
      applyInactiveStatus(cfg);
      return undefined;
    }

    const openCxPaths = getOpenCxDocs().map((doc) => doc.uri.fsPath);
    const [binaryRes, isInternalCore, workspaceDirs, workspaceFolders] =
      resolveToolchain(openCxPaths);
    if (!binaryRes.isFound) {
      reportMissingBinary(binaryRes, cfg[4]);
      return undefined;
    }

    lastMissingKey = undefined;
    const { binaryPath } = binaryRes;
    setStatus(ICON_SPIN, 'Starting…');
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
            showErrorPrompt(msg, RESTART_LABEL, () => execVsCmd(CMD_RESTART));
            return;
          }
          const delay = 250 * 2 ** (crashTimestamps.length - 1);
          setStatus(ICON_SPIN, `Retry in ${delay} ms…`);
          armTimer(1, delay, () => runDetached(reconcileSession()));
        },
        onProtocolError: logWarn,
        onPublishDiagnostics: ({ diagnostics, uri, version }: LspPublishDiagnosticsParams) => {
          if (activeClient === client) {
            const targetUri = VsUri.parse(uri);
            const canonicalUri = targetUri.toString();
            pullResultIds.delete(canonicalUri);
            const knownVer = openDocVersions.get(canonicalUri);
            if (knownVer !== undefined && (version === undefined || version >= knownVer)) {
              publishDocDiags(targetUri, diagnostics);
            }
          }
        },
        onStderr: (line) => logInfo(`[lsp] ${line}`),
        onTrace: logTrace,
        traceMode: cfg[6],
        workspaceFolders,
      });

      if (isDeactivated || gen !== sessionGen) {
        await client.stop();
        return undefined;
      }

      activeClient = client;
      ensureLspProviders(client);
      for (const doc of getOpenCxDocs()) {
        syncOpenedDoc(doc);
      }
      inlayHintsEmitter?.fire();

      const serverVer = `v${client.initializeResult.serverInfo?.version ?? '0.1.0'}`;
      setStatus(ICON_CHECK, serverVer);
      logInfo(`LSP ${serverVer}`);
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

/**
 * Updates a boolean `corex.<key>` setting in user configuration.
 *
 * @param key       Setting key under `corex.*`.
 * @param nextVal   New boolean value to persist.
 */
function updateCorexBool(key: string, nextVal: boolean): Thenable<void> {
  return getCorexWorkspaceConfig().update(key, nextVal, true);
}

/**
 * Encodes a 0-based `Position` (`character < 10^8`) into a monotonic comparable integer key.
 *
 * @param pos   VS Code UTF-16 position.
 */
function encodePosKey(pos: Position): number {
  return pos.line * 1e8 + pos.character;
}

/** Applies all non-overlapping `isPreferred` (`MachineApplicable`) quick-fix edits in the active `.cx` editor. */
async function fixAllSafeIssues(): Promise<boolean> {
  const doc = vsWindow.activeTextEditor?.document;
  const rawActions =
    doc &&
    (await queryDoc(
      doc,
      'codeAction',
      toRangeParam(new VsRange(0, 0, doc.lineCount, 0), true),
      undefined,
      (rawVal) => (isArray(rawVal) ? (rawVal as readonly LspCodeAction[]) : null)
    ));
  const merged = new WorkspaceEdit();
  for (const item of rawActions ?? []) {
    for (const [uri, nextEdits] of (item.isPreferred && toVsWorkspaceEdit(item.edit)?.entries()) ||
      []) {
      const prevEdits = merged.get(uri);
      if (
        nextEdits[0] &&
        !nextEdits.some(({ range: rangeA }) => {
          const startA = encodePosKey(rangeA.start);
          return prevEdits.some(({ range: rangeB }) => {
            const startB = encodePosKey(rangeB.start);
            const endB = encodePosKey(rangeB.end);
            return (
              (startA < endB && startB < encodePosKey(rangeA.end)) ||
              (startA === startB && startA === endB)
            );
          });
        })
      ) {
        merged.set(uri, [...prevEdits, ...nextEdits]);
      }
    }
  }
  return Boolean(merged.size && (await vsWorkspace.applyEdit(merged)));
}

/** Triggers a detached fresh session reconciliation. */
function triggerFreshReconcile(): void {
  runDetached(reconcileSession(1));
}

/** Starts or restarts `corex lsp` on user command, warning if the workspace is untrusted. */
async function restartFromCommand(): Promise<LspClientSession | undefined> {
  if (!isWsTrusted()) {
    runDetached(vsWindow.showWarningMessage('Grant Workspace Trust to run CoreX.'));
    return undefined;
  }
  if (!readCfgTuple()[1]) {
    await updateCorexBool(LSP_ENABLE_KEY, true);
  }
  return reconcileSession(1);
}

/** Stops any running `corex lsp` server until restarted by the user or configuration change. */
function stopServerManually(): Promise<LspClientSession | undefined> | undefined {
  return isWsTrusted() ? reconcileSession(2) : undefined;
}

/**
 * Builds a command handler toggling a boolean `corex.*` setting at tuple index `idx`.
 *
 * @param key   Setting key under `corex.*`.
 * @param idx   Tuple index inside `readCfgTuple()`.
 */
function bindBoolToggle(key: string, idx: 2 | 3): () => Thenable<void> {
  return () => updateCorexBool(key, !readCfgTuple()[idx]);
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
  editorDecos ??= [
    {
      borderColor: new ThemeColor('editorIndentGuide.background1'),
      borderStyle: 'dotted',
      borderWidth: '0 0 0 1px',
    },
    { opacity: '0.58' },
  ].map((options) => vsWindow.createTextEditorDecorationType(options)) as unknown as [
    TextEditorDecorationType,
    TextEditorDecorationType,
  ];
  const [stripDeco, mutedDeco] = editorDecos;

  const stripRanges: Range[] = [];
  const mutedRanges: Range[] = [];
  const lastDocLine = document.lineCount - 1;
  let prevVisEnd = -1;
  let scannedCount = 0;

  for (const visibleRange of visibleRanges) {
    const visEnd = numMin(lastDocLine, visibleRange.end.line);
    const emitStart = numMax(visibleRange.start.line, prevVisEnd + 1);
    const scanEnd = numMin(lastDocLine, visEnd + 256);
    let openLine = -1;
    let openHashes = '';

    /** Appends connected strip-guide ranges at `colC` when `(openLine, closeLine)` has preserved leading spaces. */
    function appendBlockGuides(closeLine: number, colC: number): void {
      if (colC <= 0 || closeLine - openLine > 256) {
        return;
      }
      const prevLen = stripRanges.length;
      let hasExtraSpace = false;
      for (let innerIdx = openLine + 1; innerIdx < closeLine; innerIdx += 1) {
        const { text } = document.lineAt(innerIdx);
        hasExtraSpace ||= text.charCodeAt(colC) === 32;
        if (innerIdx >= emitStart && innerIdx <= visEnd && text.length >= colC) {
          stripRanges.push(createLineRange(innerIdx, colC));
        }
      }
      if (!hasExtraSpace) {
        stripRanges.length = prevLen;
      }
    }

    /** Scans non-comment, non-string tokens on `lineText` from `startCol`. */
    function scanCodeTokens(
      lineText: string,
      lineIdx: number,
      startCol: number
    ): string | undefined {
      const isEmittable = lineIdx >= emitStart && lineIdx <= visEnd;
      const discardMatch = !startCol && isEmittable && PURE_DISCARD_RX.exec(lineText);
      if (discardMatch) {
        mutedRanges.push(
          createLineRange(lineIdx, lineText.indexOf('_'), (discardMatch[1] as string).length)
        );
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
          LINE_TOKEN_RX.lastIndex =
            closeIdx === -1 ? lineText.length : closeIdx + closeDelim.length;
        } else if (tokMatch[5] && isEmittable) {
          mutedRanges.push(createLineRange(lineIdx, tokMatch.index, tokMatch[5].length));
        }
      }
      return undefined;
    }

    for (
      let lineIdx = numMax(0, visibleRange.start.line - 256);
      lineIdx <= scanEnd && scannedCount < 4096;
      lineIdx += 1
    ) {
      scannedCount += 1;
      const lineText = document.lineAt(lineIdx).text;
      let colIdx = 0;

      if (openLine >= 0) {
        const closeMatch = CLOSE_MULTILINE_RX.exec(lineText);
        if (closeMatch?.[2] === openHashes) {
          appendBlockGuides(lineIdx, (closeMatch[1] as string).length);
          openLine = -1;
          colIdx = closeMatch[0].length;
        }
      }

      if (openLine < 0) {
        const nextHashes = scanCodeTokens(lineText, lineIdx, colIdx);
        if (nextHashes !== undefined) {
          openLine = lineIdx;
          openHashes = nextHashes;
        }
      }
    }
    prevVisEnd = numMax(prevVisEnd, visEnd);
  }

  editor.setDecorations(stripDeco, stripRanges);
  editor.setDecorations(mutedDeco, mutedRanges);
}

/** Schedules a `35 ms` debounced decoration pass across all visible `.cx` editors. */
function scheduleDecorations(): void {
  armTimer(0, 35, () => {
    const editors = vsWindow.visibleTextEditors;
    for (const editor of editors[0] ? editors : [vsWindow.activeTextEditor]) {
      if (editor) {
        updateEditorDecorations(editor);
      }
    }
  });
}

// ------------------------------------- PUBLIC API --------------------------------------

/**
 * Activates the CoreX VS Code extension (`onLanguage:corex`, `workspaceContains:corex.toml`).
 *
 * @param context   VS Code extension host lifecycle context.
 */
export function activate(context: ExtensionContext): void {
  isDeactivated = false;
  extVersion =
    readOptStr(
      (
        context as {
          readonly extension?: { readonly packageJSON?: { readonly version?: unknown } };
        }
      ).extension?.packageJSON?.version
    ) ?? '1.0.0';
  diagnosticCollection = vsLangs.createDiagnosticCollection(COREX_CONFIG_SECTION);
  inlayHintsEmitter = new EventEmitter<void>();
  const watcher = vsWorkspace.createFileSystemWatcher('**/{*.cx,corex.toml,corex.lock}');
  const toggleFormat = bindBoolToggle(FORMAT_ENABLE_KEY, 2);
  const toggleHints = bindBoolToggle(INLAY_HINTS_KEY, 3);

  context.subscriptions.push(
    ...[
      [`${COREX_CONFIG_SECTION}.fixAll`, fixAllSafeIssues],
      [CMD_FMT, toggleFormat],
      [CMD_OUTPUT, showOutputChannel],
      [CMD_RESTART, restartFromCommand],
      [CMD_STOP, stopServerManually],
      [
        CMD_STATUS,
        () => {
          const cfg = readCfgTuple();
          const [client, fmtMode, lspDetail, hintsStatus] = describeServices(lastStatusState?.[1]);
          const isFault = isFaultIcon(lastStatusState?.[0]);
          const activeFsPath = vsWindow.activeTextEditor?.document.uri.fsPath;
          const tomlPath = findProjectToml([
            activeFsPath ? pathDirname(activeFsPath) : '',
            ...getFileWsFolders().map((folder) => folder.uri.fsPath),
          ]);
          const restartEntry = [
            'refresh',
            `${RESTART_LABEL} ${LANG_SERVER_TEXT}`,
            restartFromCommand,
            lspDetail,
          ] as const;
          const outputEntry = [
            'output',
            SHOW_OUTPUT_LABEL,
            showOutputChannel,
            cfg[6] === 'off' ? undefined : cfg[6],
          ] as const;
          return vsWindow
            .showQuickPick(
              (
                [
                  ...(isFault ? (['Troubleshooting', restartEntry, outputEntry] as const) : []),
                  'Actions',
                  [
                    'wand',
                    `Format ${DOC_WORD}`,
                    () => execVsCmd(`editor.action.format${DOC_WORD}`),
                    fmtMode || DISABLED_TEXT,
                  ],
                  ['sparkle', 'Fix All Safe Issues', fixAllSafeIssues],
                  ['eye', `Toggle ${INLAY_HINTS_LABEL}`, toggleHints, hintsStatus],
                  [
                    cfg[2] ? ICON_OFF : ICON_CHECK,
                    `${cfg[2] ? 'Disable' : 'Enable'} ${FMT_WORD}`,
                    toggleFormat,
                  ],
                  LANG_SERVER_TEXT,
                  !isFault && restartEntry,
                  [
                    `${client ? 'stop' : 'play'}-circle`,
                    `${client ? 'Stop' : 'Start'} ${LANG_SERVER_TEXT}`,
                    client ? stopServerManually : restartFromCommand,
                  ],
                  'Configuration',
                  tomlPath &&
                    ([
                      'go-to-file',
                      'Open Project Config',
                      () => execVsCmd('vscode.open', VsUri.file(tomlPath)),
                      vsWorkspace.asRelativePath(tomlPath, false),
                    ] as const),
                  ['gear', SETTINGS_LABEL, openCorexSettings],
                  !isFault && outputEntry,
                ] as const
              ).flatMap((row): StatusMenuEntry[] =>
                row
                  ? [
                      typeof row === 'string'
                        ? { kind: -1 as QuickPickItemKind, label: row }
                        : {
                            cb: row[2],
                            description: row[3],
                            kind: 0 as QuickPickItemKind,
                            label: `$(${row[0]}) ${row[1]}`,
                          },
                    ]
                  : []
              )
            )
            .then((pickedItem) => pickedItem?.cb?.());
        },
      ],
      [CMD_HINTS, toggleHints],
    ].map(([cmdId, handler]) => vsCmds.registerCommand(cmdId as string, handler as () => unknown)),
    subscribeDidEvent(vsWindow, '~ActiveTextEditor', scheduleDecorations),
    subscribeDidEvent(vsWindow, '~TextEditorVisibleRanges', scheduleDecorations),
    subscribeDidEvent<TextDocument>(vsWorkspace, 'Open#', syncOpenedDoc),
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
            syncOpenedDoc(document);
          } else if (
            notifyTextDocument(client, 'didChange', uri, {
              contentChanges: contentChanges.map(({ range, text }) => ({
                ...toRangeParam(range),
                text,
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
      () => isWsTrusted() && triggerFreshReconcile()
    ),
    subscribeDidEvent<{ readonly affectsConfiguration: (section: string) => boolean }>(
      vsWorkspace,
      '~Configuration',
      (configEvent) => {
        if (configEvent.affectsConfiguration(COREX_CONFIG_SECTION)) {
          const prev = readCfgTuple();
          invalidateConfigCache();
          const next = readCfgTuple();
          if (([0, 1, 4, 5] as const).some((idx) => prev[idx] !== next[idx])) {
            triggerFreshReconcile();
          } else {
            if (prev[6] !== next[6]) {
              activeClient?.setTraceMode(next[6]);
            }
            syncFormatProviders();
            if (prev[3] !== next[3]) {
              inlayHintsEmitter?.fire();
            }
            if (lastStatusState && next[0]) {
              setStatus(...lastStatusState);
            }
          }
        }
      }
    ),
    ...(['Create', '~', 'Delete'] as const).map((evName, idx) =>
      subscribeDidEvent<Uri>(watcher, evName, (uri) => {
        const changeType = (idx + 1) as LspFileChangeType;
        const canonicalUri = uri.toString();
        if (
          isDeactivated ||
          !isCorexActive() ||
          uri.scheme !== FILE_SCHEME ||
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
        armTimer(2, 75, () => {
          const client = getRunningClient();
          if (client && pendingWatchedEvents.size) {
            client.notify('workspace/didChangeWatchedFiles', {
              changes: [...pendingWatchedEvents].map(([watchedUri, type]) => ({
                type,
                uri: watchedUri,
              })),
            });
            refreshSiblingDocs();
          }
          pendingWatchedEvents.clear();
        });
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
  for (const timer of activeTimers) {
    clearTimer(timer);
  }
  activeTimers.length = 0;
  await reconcileSession();
  disposeList(lspProviderSubs);
  disposeList(formatProviderSubs);
  for (const item of [
    ...(editorDecos ?? []),
    statusBarItem,
    inlayHintsEmitter,
    diagnosticCollection,
  ]) {
    item?.dispose();
  }
  [lastStatusState, editorDecos, statusBarItem] = [] as undefined[];
  pendingWatchedEvents.clear();
  crashTimestamps.length = 0;
  disposeLogger();
}

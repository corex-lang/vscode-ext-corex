/**
 * VS Code Host API Mock – Strictly typed headless double for `vscode-ext-corex` suites.
 *
 * Emulates `Uri`, geometry/editor value constructors, `EventEmitter`, `workspace`, `window`,
 * `languages`, and `commands` using plain constructor functions with zero `class` declarations.
 *
 * Exposes deterministic `resetVscodeMock` and inspection helpers so unit and integration
 * tests verify Workspace Trust gating, configuration hot-reload, and provider wiring cleanly.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------- TYPES ----------------------------------------

// ---------------------- Core Primitives -----------------------

/** Disposable subscription handle compatible with `vscode.Disposable`. */
export interface MockDisposable {
  /** Releases the registered listener or provider. */
  readonly dispose: () => void;
}

/** Minimal cancellation token matching `vscode.CancellationToken`. */
export interface MockCancellationToken {
  /** Whether cancellation has been requested. */
  isCancellationRequested: boolean;
  /** Subscribes `listener` to cancellation events. */
  readonly onCancellationRequested: (listener: () => void) => MockDisposable;
}

/** Controllable cancellation source returned by `createMockCancelToken`. */
export interface MockCancelTokenSource {
  /** Triggers cancellation and notifies all registered listeners. */
  readonly cancel: () => void;
  /** Underlying cancellation token passed to providers or client calls. */
  readonly token: MockCancellationToken;
}

/** Event registration function matching `vscode.Event<T>`. */
export type MockEvent<T> = (listener: (eventValue: T) => unknown) => MockDisposable;

/** Strictly typed `EventEmitter<T>` mock instance. */
export interface MockEventEmitter<T> {
  /** Disposes all subscribed listeners. */
  readonly dispose: () => void;
  /** Public subscriber hook matching `vscode.EventEmitter.event`. */
  readonly event: MockEvent<T>;
  /** Broadcasts `eventValue` synchronously to all active listeners. */
  readonly fire: (...args: [T] extends [undefined] ? [eventValue?: T] : [eventValue: T]) => void;
}

/** Canonical URI mock matching `vscode.Uri`. */
export interface MockUri {
  /** Platform-native filesystem path when `scheme === 'file'`. */
  readonly fsPath: string;
  /** Normalized slash-separated URI path component. */
  readonly path: string;
  /** URI scheme (`'file'`, `'untitled'`, etc.). */
  readonly scheme: string;
  /** Canonical serialized URI string. */
  readonly toString: () => string;
}

/** Zero-based `(line, character)` UTF-16 coordinate matching `vscode.Position`. */
export interface MockPosition {
  /** Zero-based UTF-16 character column. */
  readonly character: number;
  /** Zero-based line index. */
  readonly line: number;
}

/** Half-open `[start, end)` document span matching `vscode.Range`. */
export interface MockRange {
  /** Exclusive end coordinate. */
  readonly end: MockPosition;
  /** Inclusive start coordinate. */
  readonly start: MockPosition;
}

/** Cross-file target span matching `vscode.Location`. */
export interface MockLocation {
  /** Target span within `uri`. */
  readonly range: MockRange;
  /** Target document URI. */
  readonly uri: MockUri;
}

/** Single replacement or EOL edit matching `vscode.TextEdit`. */
export interface MockTextEdit {
  /** Optional line-ending normalization target (`EndOfLine.LF` or `EndOfLine.CRLF`). */
  readonly eol?: number;
  /** Replacement text string. */
  readonly newText: string;
  /** Replaced span inside the target document. */
  readonly range: MockRange;
}

/** Multi-URI workspace edit container matching `vscode.WorkspaceEdit`. */
export interface MockWorkspaceEdit {
  /** Returns all `[uri, edits]` pairs recorded on this edit. */
  readonly entries: () => [MockUri, MockTextEdit[]][];
  /** Returns edits recorded for `uri` (or `[]` when absent). */
  readonly get: (uri: MockUri) => MockTextEdit[];
  /** Returns `true` when edits exist for `uri`. */
  readonly has: (uri: MockUri) => boolean;
  /** Replaces the edit list associated with `uri`. */
  readonly set: (uri: MockUri, edits: readonly MockTextEdit[]) => void;
  /** Number of distinct document URIs modified by this edit. */
  readonly size: number;
}

// -------------- Diagnostics & Rich Intelligence ---------------

/** Secondary diagnostic span matching `vscode.DiagnosticRelatedInformation`. */
export interface MockDiagnosticRelatedInformation {
  /** Target secondary location. */
  readonly location: MockLocation;
  /** Secondary explanatory message. */
  readonly message: string;
}

/** Compiler or SAST diagnostic item matching `vscode.Diagnostic`. */
export interface MockDiagnostic {
  /** Diagnostic error/warning code (`'E0301'`, etc.). */
  code?: number | string | { readonly target: MockUri; readonly value: number | string };
  /** Primary human-readable message. */
  message: string;
  /** Primary document range. */
  range: MockRange;
  /** Optional secondary spans. */
  relatedInformation?: MockDiagnosticRelatedInformation[];
  /** Zero-based `DiagnosticSeverity` (`0 = Error`, `1 = Warning`, `2 = Info`, `3 = Hint`). */
  severity: number;
  /** Diagnostic producer name (`'corex'`). */
  source?: string;
  /** Optional `DiagnosticTag` array (`1 = Unnecessary`, `2 = Deprecated`). */
  tags?: number[];
}

/** Markdown documentation wrapper matching `vscode.MarkdownString`. */
export interface MockMarkdownString {
  /** Whether command links are trusted inside this Markdown block. */
  isTrusted?: boolean;
  /** Raw Markdown source string. */
  value: string;
}

/** Hover card result matching `vscode.Hover`. */
export interface MockHover {
  /** Rendered Markdown or plain string content. */
  readonly contents: string | MockMarkdownString | readonly (string | MockMarkdownString)[];
  /** Optional highlighted token span. */
  readonly range?: MockRange;
}

/** Intra-document occurrence highlight matching `vscode.DocumentHighlight`. */
export interface MockDocumentHighlight {
  /** Zero-based `DocumentHighlightKind` (`0 = Text`, `1 = Read`, `2 = Write`). */
  readonly kind: number;
  /** Highlighted occurrence span. */
  readonly range: MockRange;
}

/** Hierarchical outline symbol node matching `vscode.DocumentSymbol`. */
export interface MockDocumentSymbol {
  /** Child outline symbols. */
  children: MockDocumentSymbol[];
  /** Signature or type detail text. */
  detail: string;
  /** Zero-based `SymbolKind`. */
  kind: number;
  /** Symbol identifier name. */
  name: string;
  /** Full declaration span. */
  range: MockRange;
  /** Identifier selection span inside `range`. */
  selectionRange: MockRange;
  /** Optional `SymbolTag` array. */
  tags?: number[];
}

/** Flat workspace symbol record matching `vscode.SymbolInformation`. */
export interface MockSymbolInformation {
  /** Enclosing module or type name. */
  containerName: string;
  /** Zero-based `SymbolKind`. */
  kind: number;
  /** Target declaration location. */
  location: MockLocation;
  /** Symbol identifier name. */
  name: string;
  /** Optional `SymbolTag` array. */
  tags?: number[];
}

/** Completion candidate matching `vscode.CompletionItem`. */
export interface MockCompletionItem {
  /** Concise type or signature detail. */
  detail?: string;
  /** Optional plain or Markdown documentation. */
  documentation?: string | MockMarkdownString;
  /** Replacement text inserted on acceptance. */
  insertText?: string;
  /** Zero-based `CompletionItemKind`. */
  kind?: number;
  /** Display label. */
  label: string;
  /** Optional explicit replacement range. */
  range?: MockRange;
  /** Lexicographic sort key preserving server ranking. */
  sortText?: string;
  /** Optional `CompletionItemTag` array. */
  tags?: number[];
}

/** Completion candidate list matching `vscode.CompletionList`. */
export interface MockCompletionList {
  /** Whether typing further characters should re-query the server. */
  isIncomplete: boolean;
  /** Ordered completion items. */
  items: MockCompletionItem[];
}

/** Signature parameter metadata matching `vscode.ParameterInformation`. */
export interface MockParameterInformation {
  /** Optional parameter documentation. */
  documentation?: string | MockMarkdownString;
  /** Parameter label text or `[start, end)` slice offsets. */
  label: string | [number, number];
}

/** Callable signature metadata matching `vscode.SignatureInformation`. */
export interface MockSignatureInformation {
  /** Candidate-specific active parameter index. */
  activeParameter?: number;
  /** Optional signature documentation. */
  documentation?: string | MockMarkdownString;
  /** Full signature label string. */
  label: string;
  /** Ordered parameter descriptors. */
  parameters: MockParameterInformation[];
}

/** Call-site signature help payload matching `vscode.SignatureHelp`. */
export interface MockSignatureHelp {
  /** Zero-based active parameter index. */
  activeParameter: number;
  /** Zero-based active overload index. */
  activeSignature: number;
  /** Candidate signatures. */
  signatures: MockSignatureInformation[];
}

/** Editor inlay hint matching `vscode.InlayHint`. */
export interface MockInlayHint {
  /** Optional `InlayHintKind` (`1 = Type`, `2 = Parameter`). */
  kind?: number;
  /** Rendered hint label text. */
  label: string;
  /** Whether spacing is rendered before `label`. */
  paddingLeft?: boolean;
  /** Whether spacing is rendered after `label`. */
  paddingRight?: boolean;
  /** Anchor position in the document. */
  position: MockPosition;
  /** Optional click-to-insert edits. */
  textEdits?: MockTextEdit[];
  /** Optional hover tooltip. */
  tooltip?: string | MockMarkdownString;
}

/** Quick-fix or refactor action matching `vscode.CodeAction`. */
export interface MockCodeAction {
  /** Diagnostics addressed by this action. */
  diagnostics?: MockDiagnostic[];
  /** Workspace edit applied when invoked. */
  edit?: MockWorkspaceEdit;
  /** Whether this quick-fix is marked preferred. */
  isPreferred?: boolean;
  /** Action kind string (`'quickfix'`, etc.). */
  kind?: string;
  /** Human-readable action title. */
  title: string;
}

/** Semantic token legend matching `vscode.SemanticTokensLegend`. */
export interface MockSemanticTokensLegend {
  /** Ordered modifier names. */
  readonly tokenModifiers: readonly string[];
  /** Ordered token type names. */
  readonly tokenTypes: readonly string[];
}

/** Full semantic token buffer matching `vscode.SemanticTokens`. */
export interface MockSemanticTokens {
  /** Flat 5-integer-per-token encoded array. */
  readonly data: Uint32Array;
  /** Optional snapshot identifier for delta requests. */
  readonly resultId?: string;
}

/** Single semantic token array splice matching `vscode.SemanticTokensEdit`. */
export interface MockSemanticTokensEdit {
  /** Optional replacement integer slice. */
  readonly data?: Uint32Array;
  /** Number of integers deleted at `start`. */
  readonly deleteCount: number;
  /** Start offset in previous token data. */
  readonly start: number;
}

/** Incremental semantic token delta matching `vscode.SemanticTokensEdits`. */
export interface MockSemanticTokensEdits {
  /** Ordered array edits. */
  readonly edits: readonly MockSemanticTokensEdit[];
  /** Optional updated snapshot identifier. */
  readonly resultId?: string;
}

/** Theme color reference matching `vscode.ThemeColor`. */
export interface MockThemeColor {
  /** Canonical VS Code theme color identifier. */
  readonly id: string;
}

// --------------------- Host Surface Types ---------------------

/** Mock VS Code output channel recording appended lines for test assertions. */
export interface MockOutputChannel {
  /** Appends raw text without a trailing newline. */
  readonly append: (value: string) => void;
  /** Appends `value` as a complete log line. */
  readonly appendLine: (value: string) => void;
  /** Clears recorded output lines. */
  readonly clear: () => void;
  /** Marks the channel disposed. */
  readonly dispose: () => void;
  /** Hides the channel in the UI mock. */
  readonly hide: () => void;
  /** Whether `dispose()` has been called. */
  isDisposed: boolean;
  /** Whether the channel is currently visible. */
  isShown: boolean;
  /** Last `preserveFocus` boolean passed to `show()`. */
  isLastPreserveFocus?: boolean;
  /** Recorded lines written via `appendLine` / `append`. */
  readonly lines: string[];
  /** Output channel display title (`'CoreX'`). */
  readonly name: string;
  /** Reveals the output channel. */
  readonly show: (isPreservingFocus?: boolean) => void;
}

/** Mock VS Code status-bar item recording Codicon text, color, and visibility. */
export interface MockStatusBarItem {
  /** `StatusBarAlignment` (`1 = Left`, `2 = Right`). */
  readonly alignment: number;
  /** Optional warning/error background theme color. */
  backgroundColor?: MockThemeColor;
  /** Command ID invoked on click. */
  command?: string;
  /** Disposes the status-bar item. */
  readonly dispose: () => void;
  /** Hides the status-bar item. */
  readonly hide: () => void;
  /** Whether `dispose()` has been called. */
  isDisposed: boolean;
  /** Whether `show()` is currently active. */
  isVisible: boolean;
  /** Accessible status-bar item name. */
  name?: string;
  /** Layout priority number. */
  readonly priority?: number;
  /** Shows the status-bar item. */
  readonly show: () => void;
  /** Status-bar label text (e.g., `'$(check) CoreX'`). */
  text: string;
  /** Hover tooltip string or trusted `MarkdownString`. */
  tooltip?: string | MockMarkdownString;
}

/** Mock VS Code diagnostic collection keyed by canonical URI string. */
export interface MockDiagnosticCollection {
  /** Clears diagnostics across all URIs. */
  readonly clear: () => void;
  /** Deletes diagnostics for `uri`. */
  readonly delete: (uri: MockUri) => void;
  /** Marks the collection disposed and clears entries. */
  readonly dispose: () => void;
  /** Reads diagnostics currently stored for `uri`. */
  readonly get: (uri: MockUri) => readonly MockDiagnostic[] | undefined;
  /** Returns `true` when diagnostics are stored for `uri`. */
  readonly has: (uri: MockUri) => boolean;
  /** Whether `dispose()` has been called. */
  isDisposed: boolean;
  /** Collection identifier (`'corex'`). */
  readonly name: string;
  /** Sets or clears diagnostics for `uri`. */
  readonly set: (uri: MockUri, diagnostics: readonly MockDiagnostic[] | undefined) => void;
}

/** Mock `vscode.TextDocument` supporting `LF`/`CRLF` buffers and version increments. */
export interface MockTextDocument {
  /** Document line-ending mode (`EndOfLine.LF = 1`, `EndOfLine.CRLF = 2`). */
  eol: number;
  /** Returns current full buffer text. */
  readonly getText: () => string;
  /** Language identifier (`'corex'`, `'plaintext'`, etc.). */
  readonly languageId: string;
  /** Number of lines in the current buffer. */
  lineCount: number;
  /** Document URI. */
  readonly uri: MockUri;
  /** Monotonic document version number. */
  version: number;
}

/** Input options for `openMockDocument`. */
export interface OpenMockDocumentOptions {
  /** Explicit `EndOfLine` override (`1 = LF`, `2 = CRLF`; inferred from `text` when omitted). */
  readonly eol?: number;
  /** Filesystem path converted via `Uri.file(fsPath)` when `uri` is omitted. */
  readonly fsPath?: string;
  /** Language ID (`'corex'` by default). */
  readonly languageId?: string;
  /** Initial document contents. */
  readonly text: string;
  /** Explicit URI string parsed via `Uri.parse(uri)` (e.g., `'untitled:Untitled-1'`). */
  readonly uri?: string;
  /** Initial version number (`1` by default). */
  readonly version?: number;
}

/** Single content-change entry inside `MockTextDocumentChangeEvent`. */
export interface MockTextDocumentContentChange {
  /** Replaced span in the document prior to the edit. */
  readonly range: MockRange;
  /** Replacement text. */
  readonly text: string;
}

/** Event payload emitted on `workspace.onDidChangeTextDocument`. */
export interface MockTextDocumentChangeEvent {
  /** Ordered content-change entries. */
  readonly contentChanges: readonly MockTextDocumentContentChange[];
  /** Modified document handle. */
  readonly document: MockTextDocument;
}

/** Event payload emitted on `workspace.onDidChangeConfiguration`. */
export interface MockConfigurationChangeEvent {
  /** Returns `true` when `section` matches or prefixes a modified key. */
  readonly affectsConfiguration: (section: string) => boolean;
}

/** Workspace folder entry inside `workspace.workspaceFolders`. */
export interface MockWorkspaceFolder {
  /** Zero-based workspace folder index. */
  readonly index: number;
  /** Basename display label. */
  readonly name: string;
  /** Folder `file:` URI. */
  readonly uri: MockUri;
}

/** Controllable `FileSystemWatcher` mock with synthetic event triggers. */
export interface MockFileSystemWatcher {
  /** Disposes watcher listeners. */
  readonly dispose: () => void;
  /** Simulates a file-modified event. */
  readonly fireChange: (uri: MockUri) => void;
  /** Simulates a file-created event. */
  readonly fireCreate: (uri: MockUri) => void;
  /** Simulates a file-deleted event. */
  readonly fireDelete: (uri: MockUri) => void;
  /** Whether `dispose()` has been called. */
  isDisposed: boolean;
  /** Subscribes to file modification events. */
  readonly onDidChange: MockEvent<MockUri>;
  /** Subscribes to file creation events. */
  readonly onDidCreate: MockEvent<MockUri>;
  /** Subscribes to file deletion events. */
  readonly onDidDelete: MockEvent<MockUri>;
  /** Glob pattern passed to `createFileSystemWatcher`. */
  readonly pattern: string;
}

/** Snapshot of active language providers registered via `vscode.languages`. */
export interface MockProviderRegistry {
  /** Active `CodeActionsProvider` instances. */
  readonly codeActions: unknown[];
  /** Active `CompletionItemProvider` instances. */
  readonly completion: unknown[];
  /** Active `DefinitionProvider` instances. */
  readonly definition: unknown[];
  /** Active `DocumentFormattingEditProvider` instances. */
  readonly documentFormatting: unknown[];
  /** Active `DocumentHighlightProvider` instances. */
  readonly documentHighlight: unknown[];
  /** Active `DocumentRangeFormattingEditProvider` instances. */
  readonly documentRangeFormatting: unknown[];
  /** Active `DocumentRangeSemanticTokensProvider` instances. */
  readonly documentRangeSemanticTokens: unknown[];
  /** Active `DocumentSemanticTokensProvider` instances. */
  readonly documentSemanticTokens: unknown[];
  /** Active `DocumentSymbolProvider` instances. */
  readonly documentSymbol: unknown[];
  /** Active `HoverProvider` instances. */
  readonly hover: unknown[];
  /** Active `InlayHintsProvider` instances. */
  readonly inlayHints: unknown[];
  /** Active `ReferenceProvider` instances. */
  readonly references: unknown[];
  /** Active `RenameProvider` instances. */
  readonly rename: unknown[];
  /** Active `SignatureHelpProvider` instances. */
  readonly signatureHelp: unknown[];
  /** Active `TypeDefinitionProvider` instances. */
  readonly typeDefinition: unknown[];
  /** Active `WorkspaceSymbolProvider` instances. */
  readonly workspaceSymbol: unknown[];
}

/** Recorded toast notification entry for error and warning dialogs. */
export interface RecordedToastMessage {
  /** Action button labels offered on the toast. */
  readonly items: readonly string[];
  /** Primary notification text. */
  readonly message: string;
}

// ------------------- Constructor Contracts --------------------

/** Constructible `Position` factory type without `class` syntax. */
export type PositionConstructor = new (line: number, character: number) => MockPosition;

/** Constructible `Range` factory supporting 2-arg `Position` and 4-arg coordinate forms. */
export interface RangeConstructor {
  /** Creates a `MockRange` from start and end `MockPosition` objects. */
  new (start: MockPosition, end: MockPosition): MockRange;
  /** Creates a `MockRange` from `(startLine, startCharacter, endLine, endCharacter)`. */
  new (startLine: number, startCharacter: number, endLine: number, endCharacter: number): MockRange;
}

/** Constructible `Location` factory type. */
export type LocationConstructor = new (uri: MockUri, range: MockRange) => MockLocation;

/** Constructible `TextEdit` factory with static `replace` and `setEndOfLine` helpers. */
export interface TextEditConstructor {
  /** Creates a replacement `MockTextEdit`. */
  new (range: MockRange, newText: string): MockTextEdit;
  /** Static helper creating a replacement `MockTextEdit`. */
  readonly replace: (range: MockRange, newText: string) => MockTextEdit;
  /** Static helper creating an EOL-normalization `MockTextEdit`. */
  readonly setEndOfLine: (eol: number) => MockTextEdit;
}

/** Constructible `WorkspaceEdit` factory type. */
export type WorkspaceEditConstructor = new () => MockWorkspaceEdit;

/** Constructible `DiagnosticRelatedInformation` factory type. */
export type DiagnosticRelatedInformationConstructor = new (
  location: MockLocation,
  message: string
) => MockDiagnosticRelatedInformation;

/** Constructible `Diagnostic` factory type. */
export type DiagnosticConstructor = new (
  range: MockRange,
  message: string,
  severity?: number
) => MockDiagnostic;

/** Constructible `MarkdownString` factory type. */
export type MarkdownStringConstructor = new (
  value?: string,
  isTrusted?: boolean
) => MockMarkdownString;

/** Constructible `Hover` factory type. */
export type HoverConstructor = new (
  contents: string | MockMarkdownString | readonly (string | MockMarkdownString)[],
  range?: MockRange
) => MockHover;

/** Constructible `DocumentHighlight` factory type. */
export type DocumentHighlightConstructor = new (
  range: MockRange,
  kind?: number
) => MockDocumentHighlight;

/** Constructible `DocumentSymbol` factory type. */
export type DocumentSymbolConstructor = new (
  name: string,
  detail: string,
  kind: number,
  range: MockRange,
  selectionRange: MockRange
) => MockDocumentSymbol;

/** Constructible `SymbolInformation` factory type. */
export type SymbolInformationConstructor = new (
  name: string,
  kind: number,
  containerName: string,
  location: MockLocation
) => MockSymbolInformation;

/** Constructible `CompletionItem` factory type. */
export type CompletionItemConstructor = new (label: string, kind?: number) => MockCompletionItem;

/** Constructible `CompletionList` factory type. */
export type CompletionListConstructor = new (
  items?: MockCompletionItem[],
  isIncomplete?: boolean
) => MockCompletionList;

/** Constructible `ParameterInformation` factory type. */
export type ParameterInformationConstructor = new (
  label: string | [number, number],
  documentation?: string | MockMarkdownString
) => MockParameterInformation;

/** Constructible `SignatureInformation` factory type. */
export type SignatureInformationConstructor = new (
  label: string,
  documentation?: string | MockMarkdownString
) => MockSignatureInformation;

/** Constructible `SignatureHelp` factory type. */
export type SignatureHelpConstructor = new () => MockSignatureHelp;

/** Constructible `InlayHint` factory type. */
export type InlayHintConstructor = new (
  position: MockPosition,
  label: string,
  kind?: number
) => MockInlayHint;

/** Constructible `CodeAction` factory type. */
export type CodeActionConstructor = new (title: string, kind?: string) => MockCodeAction;

/** Constructible `SemanticTokensLegend` factory type. */
export type SemanticTokensLegendConstructor = new (
  tokenTypes: readonly string[],
  tokenModifiers?: readonly string[]
) => MockSemanticTokensLegend;

/** Constructible `SemanticTokens` factory type. */
export type SemanticTokensConstructor = new (
  data: Uint32Array,
  resultId?: string
) => MockSemanticTokens;

/** Constructible `SemanticTokensEdit` factory type. */
export type SemanticTokensEditConstructor = new (
  start: number,
  deleteCount: number,
  data?: Uint32Array
) => MockSemanticTokensEdit;

/** Constructible `SemanticTokensEdits` factory type. */
export type SemanticTokensEditsConstructor = new (
  edits: readonly MockSemanticTokensEdit[],
  resultId?: string
) => MockSemanticTokensEdits;

/** Constructible `ThemeColor` factory type. */
export type ThemeColorConstructor = new (id: string) => MockThemeColor;

/** Constructible generic `EventEmitter` factory type. */
export type EventEmitterConstructor = new <T = undefined>() => MockEventEmitter<T>;

// --------------------------------------- CONSTS ----------------------------------------

/** VS Code `EndOfLine` numeric enum constants. */
export const EndOfLine = { CRLF: 2, LF: 1 } as const;

/** VS Code `StatusBarAlignment` numeric enum constants. */
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

/** VS Code 0-based `DiagnosticSeverity` numeric enum constants. */
export const DiagnosticSeverity = { Error: 0, Hint: 3, Information: 2, Warning: 1 } as const;

/** VS Code 1-based `DiagnosticTag` numeric enum constants. */
export const DiagnosticTag = { Deprecated: 2, Unnecessary: 1 } as const;

/** VS Code 1-based `CompletionItemTag` numeric enum constants. */
export const CompletionItemTag = { Deprecated: 1 } as const;

/** VS Code 1-based `SymbolTag` numeric enum constants. */
export const SymbolTag = { Deprecated: 1 } as const;

/** VS Code 1-based `InlayHintKind` numeric enum constants. */
export const InlayHintKind = { Parameter: 2, Type: 1 } as const;

/** VS Code 0-based `DocumentHighlightKind` numeric enum constants. */
export const DocumentHighlightKind = { Read: 1, Text: 0, Write: 2 } as const;

/** VS Code `CodeActionKind` constants. */
export const CodeActionKind = {
  Empty: '',
  QuickFix: 'quickfix',
  Refactor: 'refactor',
  Source: 'source',
} as const;

// ----------------------------------- REGEX PATTERNS ------------------------------------

/** Matches URI scheme prefixes (`file:`, `untitled:`, etc.) without backtracking. */
const URI_SCHEME_RX = /^(?<scheme>[a-zA-Z][a-zA-Z0-9+.-]*):(?<rest>.*)$/;

/** Matches uppercase Windows drive letters inside `file:///D:/…` URLs without backtracking. */
const FILE_URL_UPPER_DRIVE_RX = /^file:\/\/\/(?<drive>[A-Z]):/;

/** Matches `LF` or `CRLF` line breaks for line-count calculation without backtracking. */
const DOC_LINE_SPLIT_RX = /\r?\n/;

// -------------------------------------- INTERNALS --------------------------------------

// --------------------- Mutable Mock State ---------------------

/** Current Workspace Trust state (`true` by default). */
let isWorkspaceTrustedState = true;

/** Current workspace folders (`undefined` when no folder is open). */
let workspaceFoldersState: MockWorkspaceFolder[] | undefined = undefined;

/** Open text documents tracked in `workspace.textDocuments`. */
const openDocumentsState: MockTextDocument[] = [];

/** Backing key-value store for `workspace.getConfiguration()` (`'corex.enable'`, etc.). */
const configValuesState = new Map<string, unknown>();

/** Registered command callbacks keyed by command ID. */
const commandHandlersState = new Map<string, (...args: unknown[]) => unknown>();

/** Created output channels retained for test inspection. */
const outputChannelsState: MockOutputChannel[] = [];

/** Created status-bar items retained for test inspection. */
const statusBarItemsState: MockStatusBarItem[] = [];

/** Created diagnostic collections retained for test inspection. */
const diagnosticCollectionsState: MockDiagnosticCollection[] = [];

/** Created filesystem watchers retained for test inspection. */
const watchersState: MockFileSystemWatcher[] = [];

/** Recorded `window.showErrorMessage` calls. */
const errorMessagesState: RecordedToastMessage[] = [];

/** Recorded `window.showWarningMessage` calls. */
const warningMessagesState: RecordedToastMessage[] = [];

/** Recorded QuickPick item arrays passed to `window.showQuickPick`. */
const quickPicksState: (readonly unknown[])[] = [];

/** Optional scripted button choice returned by the next `showErrorMessage` / `showWarningMessage` / `showQuickPick`. */
let nextDialogChoiceState: string | undefined = undefined;

/** Active language feature providers registered via `vscode.languages`. */
const providerRegistryState: MockProviderRegistry = {
  codeActions: [],
  completion: [],
  definition: [],
  documentFormatting: [],
  documentHighlight: [],
  documentRangeFormatting: [],
  documentRangeSemanticTokens: [],
  documentSemanticTokens: [],
  documentSymbol: [],
  hover: [],
  inlayHints: [],
  references: [],
  rename: [],
  signatureHelp: [],
  typeDefinition: [],
  workspaceSymbol: [],
};

// -------------------- Factory Constructors --------------------

/**
 * Instantiates a typed `MockEventEmitter<T>` without `class` syntax.
 */
function buildEventEmitter<T = undefined>(): MockEventEmitter<T> {
  const listeners = new Set<(eventValue: T) => unknown>();
  return {
    dispose(): void {
      listeners.clear();
    },
    event(listener: (eventValue: T) => unknown): MockDisposable {
      listeners.add(listener);
      return {
        dispose(): void {
          listeners.delete(listener);
        },
      };
    },
    fire(...args: [T] extends [undefined] ? [eventValue?: T] : [eventValue: T]): void {
      const payload = args[0] as T;
      for (const listener of listeners) {
        listener(payload);
      }
    },
  };
}

/** Event emitter backing `vscode.workspace.onDidOpenTextDocument`. */
let openDocEmitter = buildEventEmitter<MockTextDocument>();

/** Event emitter backing `vscode.workspace.onDidChangeTextDocument`. */
let changeDocEmitter = buildEventEmitter<MockTextDocumentChangeEvent>();

/** Event emitter backing `vscode.workspace.onDidSaveTextDocument`. */
let saveDocEmitter = buildEventEmitter<MockTextDocument>();

/** Event emitter backing `vscode.workspace.onDidCloseTextDocument`. */
let closeDocEmitter = buildEventEmitter<MockTextDocument>();

/** Event emitter backing `vscode.workspace.onDidGrantWorkspaceTrust`. */
let trustEmitter = buildEventEmitter();

/** Event emitter backing `vscode.workspace.onDidChangeWorkspaceFolders`. */
let foldersEmitter = buildEventEmitter();

/** Event emitter backing `vscode.workspace.onDidChangeConfiguration`. */
let configEmitter = buildEventEmitter<MockConfigurationChangeEvent>();

/**
 * Normalizes a `file://` URL string so drive letters are lowercase (`file:///d:/…`).
 *
 * @param rawHref   URL string produced by `pathToFileURL`.
 */
function normalizeFileHref(rawHref: string): string {
  return rawHref.replace(
    FILE_URL_UPPER_DRIVE_RX,
    (_full, driveLetter: string) => `file:///${driveLetter.toLowerCase()}:`
  );
}

/**
 * Creates a canonical `file:` `MockUri` from a host filesystem path.
 *
 * @param fsPath   Filesystem path to wrap.
 */
function createFileUri(fsPath: string): MockUri {
  const resolvedPath = path.resolve(fsPath);
  const urlObj = pathToFileURL(resolvedPath);
  const canonicalHref = normalizeFileHref(urlObj.href);
  return {
    fsPath: resolvedPath,
    path: urlObj.pathname,
    scheme: 'file',
    toString: () => canonicalHref,
  };
}

/**
 * Parses a serialized URI (`file://…`, `untitled:…`, etc.) into a canonical `MockUri`.
 *
 * @param rawValue   Serialized URI string.
 */
function parseMockUri(rawValue: string): MockUri {
  if (rawValue.toLowerCase().startsWith('file://')) {
    try {
      return createFileUri(fileURLToPath(rawValue));
    } catch {
      const fallbackPath = decodeURIComponent(rawValue.slice('file://'.length));
      const normalizedHref = `file://${fallbackPath.startsWith('/') ? '' : '/'}${fallbackPath}`;
      return {
        fsPath: fallbackPath,
        path: fallbackPath,
        scheme: 'file',
        toString: () => normalizedHref,
      };
    }
  }
  const match = URI_SCHEME_RX.exec(rawValue);
  const scheme = match?.groups?.scheme?.toLowerCase() ?? 'unknown';
  const uriPath = match?.groups?.rest ?? rawValue;
  return { fsPath: '', path: uriPath, scheme, toString: () => `${scheme}:${uriPath}` };
}

/**
 * Constructor function backing `Position`.
 *
 * @param line        Zero-based line index.
 * @param character   Zero-based UTF-16 column offset.
 */
function createPosition(line: number, character: number): MockPosition {
  return { character, line };
}

/**
 * Constructor function backing `Range` (supports both 2-arg `Position` and 4-arg coordinate forms).
 *
 * @param startOrLine     Start `MockPosition` or zero-based start line.
 * @param endOrStartCol   End `MockPosition` or zero-based start character.
 * @param endLine         Optional zero-based end line.
 * @param endCol          Optional zero-based end character.
 */
function createRange(
  startOrLine: MockPosition | number,
  endOrStartCol: MockPosition | number,
  endLine?: number,
  endCol?: number
): MockRange {
  if (typeof startOrLine === 'number' && typeof endOrStartCol === 'number') {
    return {
      end: createPosition(endLine ?? startOrLine, endCol ?? endOrStartCol),
      start: createPosition(startOrLine, endOrStartCol),
    };
  }
  return { end: endOrStartCol as MockPosition, start: startOrLine as MockPosition };
}

/**
 * Constructor function backing `Location`.
 *
 * @param uri     Target document URI.
 * @param range   Target span within `uri`.
 */
function createLocation(uri: MockUri, range: MockRange): MockLocation {
  return { range, uri };
}

/**
 * Constructor function backing `TextEdit`.
 *
 * @param range     Target span to replace.
 * @param newText   Replacement text.
 */
function createTextEdit(range: MockRange, newText: string): MockTextEdit {
  return { newText, range };
}

/**
 * Static helper creating an EOL-normalization `MockTextEdit`.
 *
 * @param eol   Target `EndOfLine` constant (`1 = LF`, `2 = CRLF`).
 */
function createEolTextEdit(eol: number): MockTextEdit {
  return { eol, newText: '', range: createRange(createPosition(0, 0), createPosition(0, 0)) };
}

/**
 * Constructor function backing `WorkspaceEdit`.
 */
function createWorkspaceEdit(): MockWorkspaceEdit {
  const editMap = new Map<string, [MockUri, MockTextEdit[]]>();
  return {
    entries(): [MockUri, MockTextEdit[]][] {
      return [...editMap.values()];
    },
    get(uri: MockUri): MockTextEdit[] {
      return editMap.get(uri.toString())?.[1] ?? [];
    },
    has(uri: MockUri): boolean {
      return editMap.has(uri.toString());
    },
    set(uri: MockUri, edits: readonly MockTextEdit[]): void {
      editMap.set(uri.toString(), [uri, [...edits]]);
    },
    get size(): number {
      return editMap.size;
    },
  };
}

/**
 * Constructor function backing `DiagnosticRelatedInformation`.
 *
 * @param location   Secondary target location.
 * @param message    Explanatory message.
 */
function createDiagnosticRelatedInformation(
  location: MockLocation,
  message: string
): MockDiagnosticRelatedInformation {
  return { location, message };
}

/**
 * Constructor function backing `Diagnostic`.
 *
 * @param range      Primary span.
 * @param message    Diagnostic summary text.
 * @param severity   Zero-based severity (`0 = Error` by default).
 */
function createDiagnostic(range: MockRange, message: string, severity = 0): MockDiagnostic {
  return { message, range, severity };
}

/**
 * Constructor function backing `MarkdownString`.
 *
 * @param value       Initial Markdown string (`''` by default).
 * @param isTrusted   Optional trust flag.
 */
function createMarkdownString(value = '', isTrusted?: boolean): MockMarkdownString {
  return { isTrusted, value };
}

/**
 * Constructor function backing `Hover`.
 *
 * @param contents   Hover Markdown or plain string content.
 * @param range      Optional highlighted token range.
 */
function createHover(
  contents: string | MockMarkdownString | readonly (string | MockMarkdownString)[],
  range?: MockRange
): MockHover {
  return { contents, range };
}

/**
 * Constructor function backing `DocumentHighlight`.
 *
 * @param range   Occurrence range.
 * @param kind    Zero-based highlight kind (`0 = Text` by default).
 */
function createDocumentHighlight(range: MockRange, kind = 0): MockDocumentHighlight {
  return { kind, range };
}

/**
 * Constructor function backing `DocumentSymbol`.
 *
 * @param name             Symbol name.
 * @param detail           Signature detail text.
 * @param kind             Zero-based `SymbolKind`.
 * @param range            Full declaration span.
 * @param selectionRange   Identifier selection span.
 */
function createDocumentSymbol(
  name: string,
  detail: string,
  kind: number,
  range: MockRange,
  selectionRange: MockRange
): MockDocumentSymbol {
  return { children: [], detail, kind, name, range, selectionRange };
}

/**
 * Constructor function backing `SymbolInformation`.
 *
 * @param name            Symbol name.
 * @param kind            Zero-based `SymbolKind`.
 * @param containerName   Enclosing scope label.
 * @param location        Declaration location.
 */
function createSymbolInformation(
  name: string,
  kind: number,
  containerName: string,
  location: MockLocation
): MockSymbolInformation {
  return { containerName, kind, location, name };
}

/**
 * Constructor function backing `CompletionItem`.
 *
 * @param label   Primary completion label.
 * @param kind    Optional zero-based `CompletionItemKind`.
 */
function createCompletionItem(label: string, kind?: number): MockCompletionItem {
  return { kind, label };
}

/**
 * Constructor function backing `CompletionList`.
 *
 * @param items          Initial completion candidates.
 * @param isIncomplete   Whether additional typing should re-query.
 */
function createCompletionList(
  items: MockCompletionItem[] = [],
  isIncomplete = false
): MockCompletionList {
  return { isIncomplete, items };
}

/**
 * Constructor function backing `ParameterInformation`.
 *
 * @param label           Parameter label text or `[start, end)` offsets.
 * @param documentation   Optional parameter documentation.
 */
function createParameterInformation(
  label: string | [number, number],
  documentation?: string | MockMarkdownString
): MockParameterInformation {
  return { documentation, label };
}

/**
 * Constructor function backing `SignatureInformation`.
 *
 * @param label           Full signature text.
 * @param documentation   Optional signature documentation.
 */
function createSignatureInformation(
  label: string,
  documentation?: string | MockMarkdownString
): MockSignatureInformation {
  return { documentation, label, parameters: [] };
}

/**
 * Constructor function backing `SignatureHelp`.
 */
function createSignatureHelp(): MockSignatureHelp {
  return { activeParameter: 0, activeSignature: 0, signatures: [] };
}

/**
 * Constructor function backing `InlayHint`.
 *
 * @param position   Anchor position.
 * @param label      Rendered label text.
 * @param kind       Optional `InlayHintKind`.
 */
function createInlayHint(position: MockPosition, label: string, kind?: number): MockInlayHint {
  return { kind, label, position };
}

/**
 * Constructor function backing `CodeAction`.
 *
 * @param title   Human-readable quick-fix title.
 * @param kind    Optional `CodeActionKind` string.
 */
function createCodeAction(title: string, kind?: string): MockCodeAction {
  return { kind, title };
}

/**
 * Constructor function backing `SemanticTokensLegend`.
 *
 * @param tokenTypes       Ordered token type names.
 * @param tokenModifiers   Ordered modifier names.
 */
function createSemanticTokensLegend(
  tokenTypes: readonly string[],
  tokenModifiers: readonly string[] = []
): MockSemanticTokensLegend {
  return { tokenModifiers: [...tokenModifiers], tokenTypes: [...tokenTypes] };
}

/**
 * Constructor function backing `SemanticTokens`.
 *
 * @param data       Encoded token integer array.
 * @param resultId   Optional snapshot identifier.
 */
function createSemanticTokens(data: Uint32Array, resultId?: string): MockSemanticTokens {
  return { data, resultId };
}

/**
 * Constructor function backing `SemanticTokensEdit`.
 *
 * @param start         Start index in previous array.
 * @param deleteCount   Number of deleted integers.
 * @param data          Optional replacement slice.
 */
function createSemanticTokensEdit(
  start: number,
  deleteCount: number,
  data?: Uint32Array
): MockSemanticTokensEdit {
  return { data, deleteCount, start };
}

/**
 * Constructor function backing `SemanticTokensEdits`.
 *
 * @param edits      Ordered splice edits.
 * @param resultId   Optional updated snapshot identifier.
 */
function createSemanticTokensEdits(
  edits: readonly MockSemanticTokensEdit[],
  resultId?: string
): MockSemanticTokensEdits {
  return { edits: [...edits], resultId };
}

/**
 * Constructor function backing `ThemeColor`.
 *
 * @param id   Theme color token identifier.
 */
function createThemeColor(id: string): MockThemeColor {
  return { id };
}

/**
 * Registers `provider` in `bucket` and returns a `MockDisposable` that removes it on `dispose()`.
 *
 * @param bucket     Target provider array inside `providerRegistryState`.
 * @param provider   Language provider object.
 */
function registerProviderInBucket(bucket: unknown[], provider: unknown): MockDisposable {
  bucket.push(provider);
  return {
    dispose(): void {
      for (let i = 0; i < bucket.length; i += 1) {
        if (bucket[i] === provider) {
          bucket.splice(i, 1);
          break;
        }
      }
    },
  };
}

/** Mutable text storage keyed by `MockTextDocument` reference. */
const documentBuffers = new WeakMap<MockTextDocument, string>();

/**
 * Mutates `configValuesState` and optionally broadcasts `onDidChangeConfiguration`.
 *
 * @param values          Map of full keys (`'corex.enable'`) or short keys (`'enable'`) to values.
 * @param isFiringEvent   Whether to emit `onDidChangeConfiguration`.
 */
function applyMockConfigValues(
  values: Readonly<Record<string, unknown>>,
  isFiringEvent: boolean
): void {
  const changedFullKeys: string[] = [];
  for (const [rawKey, val] of Object.entries(values)) {
    const fullKey =
      rawKey.includes('.') && rawKey.startsWith('corex.') ? rawKey : `corex.${rawKey}`;
    changedFullKeys.push(fullKey);
    if (val === undefined) {
      configValuesState.delete(fullKey);
    } else {
      configValuesState.set(fullKey, val);
    }
  }
  if (isFiringEvent) {
    configEmitter.fire({
      affectsConfiguration(section: string): boolean {
        for (const fullKey of changedFullKeys) {
          if (fullKey === section || fullKey.startsWith(`${section}.`)) {
            return true;
          }
        }
        return false;
      },
    });
  }
}

// ------------------------------------- PUBLIC API --------------------------------------

// ------------------- Constructible Exports --------------------

/** Mock `vscode.Uri` namespace. */
export const Uri = { file: createFileUri, parse: parseMockUri } as const;

/** Mock `vscode.Position` constructor. */
export const Position: PositionConstructor = createPosition as unknown as PositionConstructor;

/** Mock `vscode.Range` constructor. */
export const Range: RangeConstructor = createRange as unknown as RangeConstructor;

/** Mock `vscode.Location` constructor. */
export const Location: LocationConstructor = createLocation as unknown as LocationConstructor;

/** Mock `vscode.TextEdit` constructor with `replace` and `setEndOfLine`. */
export const TextEdit: TextEditConstructor = Object.assign(createTextEdit, {
  replace: createTextEdit,
  setEndOfLine: createEolTextEdit,
}) as unknown as TextEditConstructor;

/** Mock `vscode.WorkspaceEdit` constructor. */
export const WorkspaceEdit: WorkspaceEditConstructor =
  createWorkspaceEdit as unknown as WorkspaceEditConstructor;

/** Mock `vscode.DiagnosticRelatedInformation` constructor. */
export const DiagnosticRelatedInformation: DiagnosticRelatedInformationConstructor =
  createDiagnosticRelatedInformation as unknown as DiagnosticRelatedInformationConstructor;

/** Mock `vscode.Diagnostic` constructor. */
export const Diagnostic: DiagnosticConstructor =
  createDiagnostic as unknown as DiagnosticConstructor;

/** Mock `vscode.MarkdownString` constructor. */
export const MarkdownString: MarkdownStringConstructor =
  createMarkdownString as unknown as MarkdownStringConstructor;

/** Mock `vscode.Hover` constructor. */
export const Hover: HoverConstructor = createHover as unknown as HoverConstructor;

/** Mock `vscode.DocumentHighlight` constructor. */
export const DocumentHighlight: DocumentHighlightConstructor =
  createDocumentHighlight as unknown as DocumentHighlightConstructor;

/** Mock `vscode.DocumentSymbol` constructor. */
export const DocumentSymbol: DocumentSymbolConstructor =
  createDocumentSymbol as unknown as DocumentSymbolConstructor;

/** Mock `vscode.SymbolInformation` constructor. */
export const SymbolInformation: SymbolInformationConstructor =
  createSymbolInformation as unknown as SymbolInformationConstructor;

/** Mock `vscode.CompletionItem` constructor. */
export const CompletionItem: CompletionItemConstructor =
  createCompletionItem as unknown as CompletionItemConstructor;

/** Mock `vscode.CompletionList` constructor. */
export const CompletionList: CompletionListConstructor =
  createCompletionList as unknown as CompletionListConstructor;

/** Mock `vscode.ParameterInformation` constructor. */
export const ParameterInformation: ParameterInformationConstructor =
  createParameterInformation as unknown as ParameterInformationConstructor;

/** Mock `vscode.SignatureInformation` constructor. */
export const SignatureInformation: SignatureInformationConstructor =
  createSignatureInformation as unknown as SignatureInformationConstructor;

/** Mock `vscode.SignatureHelp` constructor. */
export const SignatureHelp: SignatureHelpConstructor =
  createSignatureHelp as unknown as SignatureHelpConstructor;

/** Mock `vscode.InlayHint` constructor. */
export const InlayHint: InlayHintConstructor = createInlayHint as unknown as InlayHintConstructor;

/** Mock `vscode.CodeAction` constructor. */
export const CodeAction: CodeActionConstructor =
  createCodeAction as unknown as CodeActionConstructor;

/** Mock `vscode.SemanticTokensLegend` constructor. */
export const SemanticTokensLegend: SemanticTokensLegendConstructor =
  createSemanticTokensLegend as unknown as SemanticTokensLegendConstructor;

/** Mock `vscode.SemanticTokens` constructor. */
export const SemanticTokens: SemanticTokensConstructor =
  createSemanticTokens as unknown as SemanticTokensConstructor;

/** Mock `vscode.SemanticTokensEdit` constructor. */
export const SemanticTokensEdit: SemanticTokensEditConstructor =
  createSemanticTokensEdit as unknown as SemanticTokensEditConstructor;

/** Mock `vscode.SemanticTokensEdits` constructor. */
export const SemanticTokensEdits: SemanticTokensEditsConstructor =
  createSemanticTokensEdits as unknown as SemanticTokensEditsConstructor;

/** Mock `vscode.ThemeColor` constructor. */
export const ThemeColor: ThemeColorConstructor =
  createThemeColor as unknown as ThemeColorConstructor;

/** Mock `vscode.EventEmitter` constructor. */
export const EventEmitter: EventEmitterConstructor =
  buildEventEmitter as unknown as EventEmitterConstructor;

// ---------------------- Host Namespaces -----------------------

/** Mock `vscode.workspace` namespace. */
export const workspace = {
  asRelativePath(pathOrUri: string | MockUri, isIncludingWorkspaceFolder?: boolean): string {
    const rawFsPath = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
    const resolvedTarget = path.resolve(rawFsPath);
    const folders = workspaceFoldersState ?? [];
    for (const folder of folders) {
      const relPath = path.relative(path.resolve(folder.uri.fsPath), resolvedTarget);
      if (relPath === '') {
        return isIncludingWorkspaceFolder ? folder.name : '';
      }
      if (!relPath.startsWith('..') && !path.isAbsolute(relPath)) {
        const normalizedRel = relPath.replaceAll('\\', '/');
        return (isIncludingWorkspaceFolder ?? folders.length > 1)
          ? `${folder.name}/${normalizedRel}`
          : normalizedRel;
      }
    }
    return rawFsPath.replaceAll('\\', '/');
  },
  createFileSystemWatcher(globPattern: string): MockFileSystemWatcher {
    const createEmitter = buildEventEmitter<MockUri>();
    const changeEmitter = buildEventEmitter<MockUri>();
    const deleteEmitter = buildEventEmitter<MockUri>();
    const watcher: MockFileSystemWatcher = {
      dispose(): void {
        watcher.isDisposed = true;
        createEmitter.dispose();
        changeEmitter.dispose();
        deleteEmitter.dispose();
      },
      fireChange: (uri: MockUri): void => changeEmitter.fire(uri),
      fireCreate: (uri: MockUri): void => createEmitter.fire(uri),
      fireDelete: (uri: MockUri): void => deleteEmitter.fire(uri),
      isDisposed: false,
      onDidChange: changeEmitter.event,
      onDidCreate: createEmitter.event,
      onDidDelete: deleteEmitter.event,
      pattern: globPattern,
    };
    watchersState.push(watcher);
    return watcher;
  },
  getConfiguration(section?: string) {
    const prefix = section ? `${section}.` : '';
    return {
      get<T = unknown>(key: string, defaultValue?: T): T | undefined {
        const fullKey = `${prefix}${key}`;
        return configValuesState.has(fullKey)
          ? (configValuesState.get(fullKey) as T)
          : defaultValue;
      },
      has(key: string): boolean {
        return configValuesState.has(`${prefix}${key}`);
      },
      update(key: string, value: unknown): Promise<void> {
        applyMockConfigValues({ [`${prefix}${key}`]: value }, true);
        return Promise.resolve();
      },
    };
  },
  get isTrusted(): boolean {
    return isWorkspaceTrustedState;
  },
  get onDidChangeConfiguration(): MockEvent<MockConfigurationChangeEvent> {
    return configEmitter.event;
  },
  get onDidChangeTextDocument(): MockEvent<MockTextDocumentChangeEvent> {
    return changeDocEmitter.event;
  },
  get onDidChangeWorkspaceFolders(): MockEvent<undefined> {
    return foldersEmitter.event;
  },
  get onDidCloseTextDocument(): MockEvent<MockTextDocument> {
    return closeDocEmitter.event;
  },
  get onDidGrantWorkspaceTrust(): MockEvent<undefined> {
    return trustEmitter.event;
  },
  get onDidOpenTextDocument(): MockEvent<MockTextDocument> {
    return openDocEmitter.event;
  },
  get onDidSaveTextDocument(): MockEvent<MockTextDocument> {
    return saveDocEmitter.event;
  },
  get textDocuments(): readonly MockTextDocument[] {
    return openDocumentsState;
  },
  get workspaceFolders(): readonly MockWorkspaceFolder[] | undefined {
    return workspaceFoldersState;
  },
};

/** Mock `vscode.window` namespace. */
export const window = {
  createOutputChannel(channelName: string): MockOutputChannel {
    const lines: string[] = [];
    const channel: MockOutputChannel = {
      append(value: string): void {
        lines.push(value);
      },
      appendLine(value: string): void {
        lines.push(value);
      },
      clear(): void {
        lines.length = 0;
      },
      dispose(): void {
        channel.isDisposed = true;
      },
      hide(): void {
        channel.isShown = false;
      },
      isDisposed: false,
      isShown: false,
      lines,
      name: channelName,
      show(isPreservingFocus?: boolean): void {
        channel.isShown = true;
        channel.isLastPreserveFocus = isPreservingFocus;
      },
    };
    outputChannelsState.push(channel);
    return channel;
  },
  createStatusBarItem(alignment = 2, priority?: number): MockStatusBarItem {
    const item: MockStatusBarItem = {
      alignment,
      dispose(): void {
        item.isDisposed = true;
        item.isVisible = false;
      },
      hide(): void {
        item.isVisible = false;
      },
      isDisposed: false,
      isVisible: false,
      priority,
      show(): void {
        item.isVisible = true;
      },
      text: '',
    };
    statusBarItemsState.push(item);
    return item;
  },
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {
    errorMessagesState.push({ items, message });
    const chosen = nextDialogChoiceState;
    nextDialogChoiceState = undefined;
    return Promise.resolve(chosen);
  },
  showQuickPick<T extends { readonly label: string }>(items: readonly T[]): Promise<T | undefined> {
    quickPicksState.push(items);
    const chosenLabel = nextDialogChoiceState;
    nextDialogChoiceState = undefined;
    if (chosenLabel === undefined) {
      return Promise.resolve(undefined);
    }
    for (const item of items) {
      if (item.label === chosenLabel || item.label.includes(chosenLabel)) {
        return Promise.resolve(item);
      }
    }
    return Promise.resolve(undefined);
  },
  showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
    warningMessagesState.push({ items, message });
    const chosen = nextDialogChoiceState;
    nextDialogChoiceState = undefined;
    return Promise.resolve(chosen);
  },
};

/** Mock `vscode.languages` namespace. */
export const languages = {
  createDiagnosticCollection(collectionName = 'default'): MockDiagnosticCollection {
    const entries = new Map<string, readonly MockDiagnostic[]>();
    const collection: MockDiagnosticCollection = {
      clear(): void {
        entries.clear();
      },
      delete(uri: MockUri): void {
        entries.delete(uri.toString());
      },
      dispose(): void {
        collection.isDisposed = true;
        entries.clear();
      },
      get(uri: MockUri): readonly MockDiagnostic[] | undefined {
        return entries.get(uri.toString());
      },
      has(uri: MockUri): boolean {
        return entries.has(uri.toString());
      },
      isDisposed: false,
      name: collectionName,
      set(uri: MockUri, diagnostics: readonly MockDiagnostic[] | undefined): void {
        if (diagnostics === undefined) {
          entries.delete(uri.toString());
        } else {
          entries.set(uri.toString(), [...diagnostics]);
        }
      },
    };
    diagnosticCollectionsState.push(collection);
    return collection;
  },
  registerCodeActionsProvider(
    _selector: unknown,
    provider: unknown,
    _metadata?: unknown
  ): MockDisposable {
    return registerProviderInBucket(providerRegistryState.codeActions, provider);
  },
  registerCompletionItemProvider(
    _selector: unknown,
    provider: unknown,
    ..._triggers: string[]
  ): MockDisposable {
    return registerProviderInBucket(providerRegistryState.completion, provider);
  },
  registerDefinitionProvider(_selector: unknown, provider: unknown): MockDisposable {
    return registerProviderInBucket(providerRegistryState.definition, provider);
  },
  registerDocumentFormattingEditProvider(_selector: unknown, provider: unknown): MockDisposable {
    return registerProviderInBucket(providerRegistryState.documentFormatting, provider);
  },
  registerDocumentHighlightProvider(_selector: unknown, provider: unknown): MockDisposable {
    return registerProviderInBucket(providerRegistryState.documentHighlight, provider);
  },
  registerDocumentRangeFormattingEditProvider(
    _selector: unknown,
    provider: unknown
  ): MockDisposable {
    return registerProviderInBucket(providerRegistryState.documentRangeFormatting, provider);
  },
  registerDocumentRangeSemanticTokensProvider(
    _selector: unknown,
    provider: unknown,
    _legend: unknown
  ): MockDisposable {
    return registerProviderInBucket(providerRegistryState.documentRangeSemanticTokens, provider);
  },
  registerDocumentSemanticTokensProvider(
    _selector: unknown,
    provider: unknown,
    _legend: unknown
  ): MockDisposable {
    return registerProviderInBucket(providerRegistryState.documentSemanticTokens, provider);
  },
  registerDocumentSymbolProvider(_selector: unknown, provider: unknown): MockDisposable {
    return registerProviderInBucket(providerRegistryState.documentSymbol, provider);
  },
  registerHoverProvider(_selector: unknown, provider: unknown): MockDisposable {
    return registerProviderInBucket(providerRegistryState.hover, provider);
  },
  registerInlayHintsProvider(_selector: unknown, provider: unknown): MockDisposable {
    return registerProviderInBucket(providerRegistryState.inlayHints, provider);
  },
  registerReferenceProvider(_selector: unknown, provider: unknown): MockDisposable {
    return registerProviderInBucket(providerRegistryState.references, provider);
  },
  registerRenameProvider(_selector: unknown, provider: unknown): MockDisposable {
    return registerProviderInBucket(providerRegistryState.rename, provider);
  },
  registerSignatureHelpProvider(
    _selector: unknown,
    provider: unknown,
    _metadata?: unknown
  ): MockDisposable {
    return registerProviderInBucket(providerRegistryState.signatureHelp, provider);
  },
  registerTypeDefinitionProvider(_selector: unknown, provider: unknown): MockDisposable {
    return registerProviderInBucket(providerRegistryState.typeDefinition, provider);
  },
  registerWorkspaceSymbolProvider(provider: unknown): MockDisposable {
    return registerProviderInBucket(providerRegistryState.workspaceSymbol, provider);
  },
};

/** Mock `vscode.commands` namespace. */
export const commands = {
  async executeCommand(commandId: string, ...args: unknown[]): Promise<unknown> {
    const handler = commandHandlersState.get(commandId);
    return handler ? await handler(...args) : undefined;
  },
  registerCommand(commandId: string, handler: (...args: unknown[]) => unknown): MockDisposable {
    commandHandlersState.set(commandId, handler);
    return {
      dispose(): void {
        if (commandHandlersState.get(commandId) === handler) {
          commandHandlersState.delete(commandId);
        }
      },
    };
  },
};

// ---------------- Test Reset & Inspection API -----------------

/** Resets all mutable mock workspace, configuration, UI, command, and provider state. */
export function resetVscodeMock(): void {
  isWorkspaceTrustedState = true;
  workspaceFoldersState = undefined;
  openDocumentsState.length = 0;
  configValuesState.clear();
  commandHandlersState.clear();
  outputChannelsState.length = 0;
  statusBarItemsState.length = 0;
  diagnosticCollectionsState.length = 0;
  watchersState.length = 0;
  errorMessagesState.length = 0;
  warningMessagesState.length = 0;
  quickPicksState.length = 0;
  nextDialogChoiceState = undefined;
  for (const key of Object.keys(providerRegistryState) as (keyof MockProviderRegistry)[]) {
    providerRegistryState[key].length = 0;
  }
  openDocEmitter.dispose();
  changeDocEmitter.dispose();
  saveDocEmitter.dispose();
  closeDocEmitter.dispose();
  trustEmitter.dispose();
  foldersEmitter.dispose();
  configEmitter.dispose();
  openDocEmitter = buildEventEmitter<MockTextDocument>();
  changeDocEmitter = buildEventEmitter<MockTextDocumentChangeEvent>();
  saveDocEmitter = buildEventEmitter<MockTextDocument>();
  closeDocEmitter = buildEventEmitter<MockTextDocument>();
  trustEmitter = buildEventEmitter();
  foldersEmitter = buildEventEmitter();
  configEmitter = buildEventEmitter<MockConfigurationChangeEvent>();
}

/**
 * Replaces or merges `corex.*` configuration keys and optionally fires `onDidChangeConfiguration`.
 *
 * @param values          Map of full keys (`'corex.enable'`) or short keys (`'enable'`) to values.
 * @param isFiringEvent   Whether to emit `onDidChangeConfiguration` (`false` by default).
 */
export function setWorkspaceConfig(
  values: Readonly<Record<string, unknown>>,
  isFiringEvent = false
): void {
  applyMockConfigValues(values, isFiringEvent);
}

/**
 * Updates `workspace.isTrusted` and optionally fires `onDidGrantWorkspaceTrust`.
 *
 * @param isTrustedNext   New Workspace Trust boolean value.
 * @param isFiringGrant   Whether to fire `onDidGrantWorkspaceTrust` when `isTrustedNext` is `true`.
 */
export function setWorkspaceTrusted(isTrustedNext: boolean, isFiringGrant = false): void {
  isWorkspaceTrustedState = isTrustedNext;
  if (isTrustedNext && isFiringGrant) {
    trustEmitter.fire();
  }
}

/**
 * Sets `workspace.workspaceFolders` from filesystem directory paths and optionally fires change events.
 *
 * @param dirPaths        Workspace root directories (`undefined` for single-file / empty window).
 * @param isFiringEvent   Whether to emit `onDidChangeWorkspaceFolders`.
 */
export function setWorkspaceFolders(
  dirPaths: readonly string[] | undefined,
  isFiringEvent = false
): void {
  if (dirPaths === undefined) {
    workspaceFoldersState = undefined;
  } else {
    const folders: MockWorkspaceFolder[] = [];
    for (let i = 0; i < dirPaths.length; i += 1) {
      const folderPath = dirPaths[i];
      if (folderPath !== undefined) {
        folders.push({
          index: i,
          name: path.basename(folderPath) || folderPath,
          uri: createFileUri(folderPath),
        });
      }
    }
    workspaceFoldersState = folders;
  }
  if (isFiringEvent) {
    foldersEmitter.fire();
  }
}

/**
 * Creates a `MockTextDocument`, appends it to `workspace.textDocuments`, and fires `onDidOpenTextDocument`.
 *
 * @param options   Document path/URI, text, EOL mode, language ID, and initial version.
 */
export function openMockDocument(options: OpenMockDocumentOptions): MockTextDocument {
  const docUri =
    options.uri !== undefined
      ? parseMockUri(options.uri)
      : createFileUri(options.fsPath ?? path.resolve('mock.cx'));
  const document: MockTextDocument = {
    eol: options.eol ?? (options.text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF),
    getText(): string {
      return documentBuffers.get(document) ?? '';
    },
    languageId: options.languageId ?? 'corex',
    lineCount: options.text.split(DOC_LINE_SPLIT_RX).length,
    uri: docUri,
    version: options.version ?? 1,
  };
  documentBuffers.set(document, options.text);
  openDocumentsState.push(document);
  openDocEmitter.fire(document);
  return document;
}

/**
 * Mutates `document`'s text, increments `document.version`, and fires `onDidChangeTextDocument`.
 *
 * @param document      Open mock document to update.
 * @param nextText      Replacement text (full buffer when `changeRange` is omitted).
 * @param changeRange   Optional replaced span corresponding to `nextText`.
 */
export function changeMockDocument(
  document: MockTextDocument,
  nextText: string,
  changeRange?: MockRange
): void {
  const prevText = document.getText();
  const prevLines = prevText.split(DOC_LINE_SPLIT_RX);
  const lastLineIdx = Math.max(0, prevLines.length - 1);
  const fullSpan = createRange(
    createPosition(0, 0),
    createPosition(lastLineIdx, (prevLines[lastLineIdx] ?? '').length)
  );
  documentBuffers.set(document, nextText);
  document.version += 1;
  document.lineCount = nextText.split(DOC_LINE_SPLIT_RX).length;
  document.eol = nextText.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF;
  changeDocEmitter.fire({
    contentChanges: [{ range: changeRange ?? fullSpan, text: nextText }],
    document,
  });
}

/**
 * Fires `onDidSaveTextDocument` for `document`.
 *
 * @param document   Open mock document to save.
 */
export function saveMockDocument(document: MockTextDocument): void {
  saveDocEmitter.fire(document);
}

/**
 * Removes `document` from `workspace.textDocuments` and fires `onDidCloseTextDocument`.
 *
 * @param document   Open mock document to close.
 */
export function closeMockDocument(document: MockTextDocument): void {
  for (let i = 0; i < openDocumentsState.length; i += 1) {
    if (openDocumentsState[i] === document) {
      openDocumentsState.splice(i, 1);
      break;
    }
  }
  closeDocEmitter.fire(document);
}

/**
 * Creates a controllable `MockCancelTokenSource` (`{ cancel, token }`).
 *
 * @param isInitiallyCanceled   Whether `token.isCancellationRequested` starts `true`.
 */
export function createMockCancelToken(isInitiallyCanceled = false): MockCancelTokenSource {
  const cancelEmitter = buildEventEmitter();
  const token: MockCancellationToken = {
    isCancellationRequested: isInitiallyCanceled,
    onCancellationRequested(listener: () => void): MockDisposable {
      if (token.isCancellationRequested) {
        listener();
        return { dispose: () => undefined };
      }
      return cancelEmitter.event(listener);
    },
  };
  return {
    cancel(): void {
      if (!token.isCancellationRequested) {
        token.isCancellationRequested = true;
        cancelEmitter.fire();
      }
    },
    token,
  };
}

/**
 * Scripts the button label returned by the next `window.showErrorMessage` or `showWarningMessage` call.
 *
 * @param choice   Button label to resolve (or `undefined` to dismiss).
 */
export function setNextDialogChoice(choice: string | undefined): void {
  nextDialogChoiceState = choice;
}

/** Returns live references to recorded UI surfaces, providers, commands, and watchers. */
export function getMockState() {
  return {
    collections: diagnosticCollectionsState,
    commands: commandHandlersState,
    errorMessages: errorMessagesState,
    outputChannels: outputChannelsState,
    providers: providerRegistryState,
    quickPicks: quickPicksState,
    statusBarItems: statusBarItemsState,
    warningMessages: warningMessagesState,
    watchers: watchersState,
  };
}

export {
  changeMockDocument as __changeMockDocument,
  closeMockDocument as __closeMockDocument,
  createMockCancelToken as __createMockCancelToken,
  getMockState as __getMockState,
  openMockDocument as __openMockDocument,
  resetVscodeMock as __resetVscodeMock,
  saveMockDocument as __saveMockDocument,
  setNextDialogChoice as __setNextDialogChoice,
  setWorkspaceConfig as __setWorkspaceConfig,
  setWorkspaceFolders as __setWorkspaceFolders,
  setWorkspaceTrusted as __setWorkspaceTrusted,
};

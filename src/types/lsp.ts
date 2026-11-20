/**
 * LSP 3.17 Wire Types – Strictly typed JSON-RPC 2.0 and Language Server Protocol payloads.
 *
 * Models the exact wire structures exchanged with `corex lsp --stdio` (`stage0/src/lsp_server.zig`),
 * covering lifecycle negotiation, incremental text sync, push/pull diagnostics, semantic tokens,
 * navigation, completion, signature help, inlay hints, quick-fixes, formatting, and rename.
 *
 * Preserves exact 1-based vs. 0-based LSP 3.17 wire discriminants prior to `vscode` host mapping.
 */

// ---------------------------------------- TYPES ----------------------------------------

// --------------------- JSON-RPC 2.0 Wire ----------------------

/** Valid JSON-RPC 2.0 request/response correlation identifier. */
export type JsonRpcId = number | string;

/** Structured JSON-RPC 2.0 error payload returned on failed or cancelled requests. */
export interface JsonRpcErrorObject {
  /** Standard JSON-RPC 2.0 or LSP 3.17 negative integer error code. */
  readonly code: number;
  /** Optional structured diagnostic payload attached by the server. */
  readonly data?: unknown;
  /** Human-readable error summary. */
  readonly message: string;
}

/** Outbound JSON-RPC 2.0 request frame body. */
export interface JsonRpcRequestMessage {
  /** Monotonic request identifier. */
  readonly id: JsonRpcId;
  /** Protocol version literal. */
  readonly jsonrpc: '2.0';
  /** Target LSP method name. */
  readonly method: string;
  /** Optional method parameter object. */
  readonly params?: unknown;
}

/** Outbound or inbound JSON-RPC 2.0 notification frame body. */
export interface JsonRpcNotificationMessage {
  /** Protocol version literal. */
  readonly jsonrpc: '2.0';
  /** Target LSP notification method name. */
  readonly method: string;
  /** Optional notification parameter object. */
  readonly params?: unknown;
}

/** Inbound JSON-RPC 2.0 response frame body. */
export interface JsonRpcResponseMessage {
  /** Error object when the request failed or was cancelled. */
  readonly error?: JsonRpcErrorObject;
  /** Matching request identifier (`null` on parse/framing errors). */
  readonly id: JsonRpcId | null;
  /** Protocol version literal. */
  readonly jsonrpc: '2.0';
  /** Result payload when the request succeeded. */
  readonly result?: unknown;
}

// ---------------------- Geometry & Sync -----------------------

/** Column offset encoding negotiated during `initialize` (`'utf-16'` in VS Code). */
// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- LSP 3.17 wire encoding literal
export type LspPositionEncoding = 'utf-16' | 'utf-8';

/** Zero-based `(line, character)` coordinate in the negotiated `LspPositionEncoding`. */
export interface LspPosition {
  /** Zero-based UTF-16 code-unit or UTF-8 byte column offset. */
  readonly character: number;
  /** Zero-based line number. */
  readonly line: number;
}

/** Half-open `[start, end)` text range in an LSP document. */
export interface LspRange {
  /** Exclusive end position. */
  readonly end: LspPosition;
  /** Inclusive start position. */
  readonly start: LspPosition;
}

/** Cross-file target span pairing a `file://` URI with an `LspRange`. */
export interface LspLocation {
  /** Target range inside `uri`. */
  readonly range: LspRange;
  /** Canonical `file://` document URI. */
  readonly uri: string;
}

/** Contiguous text replacement inside a document. */
export interface LspTextEdit {
  /** Replacement text inserted over `range`. */
  readonly newText: string;
  /** Target span to replace. */
  readonly range: LspRange;
}

/** Multi-document atomic edit map emitted by `codeAction` and `rename`. */
export interface LspWorkspaceEdit {
  /** Per-URI ordered `LspTextEdit` lists. */
  readonly changes?: Readonly<Record<string, readonly LspTextEdit[]>>;
}

/** Minimal document reference carrying its `file://` URI. */
export interface LspTextDocumentIdentifier {
  /** Target document URI. */
  readonly uri: string;
}

/** Document reference paired with its monotonic client buffer version. */
export interface LspVersionedTextDocumentIdentifier {
  /** Target document URI. */
  readonly uri: string;
  /** Monotonic editor document version number. */
  readonly version: number;
}

/** Full document snapshot transmitted in `textDocument/didOpen`. */
export interface LspTextDocumentItem {
  /** Language identifier (`'corex'`). */
  readonly languageId: string;
  /** Complete UTF-8 document source text. */
  readonly text: string;
  /** Target `file://` document URI. */
  readonly uri: string;
  /** Initial editor document version number. */
  readonly version: number;
}

/** Single incremental or full buffer change entry in `textDocument/didChange`. */
export interface LspTextDocumentContentChangeEvent {
  /** Replaced span prior to this edit (omitted for full-buffer replacement). */
  readonly range?: LspRange;
  /** Optional UTF-16 code-unit length of `range`. */
  readonly rangeLength?: number;
  /** Replacement text for `range` (or full buffer text when `range` is omitted). */
  readonly text: string;
}

/** Parameters for `textDocument/didOpen`. */
export interface LspDidOpenParams {
  /** Opened document snapshot. */
  readonly textDocument: LspTextDocumentItem;
}

/** Parameters for `textDocument/didChange`. */
export interface LspDidChangeParams {
  /** Ordered sequence of incremental or full content edits. */
  readonly contentChanges: readonly LspTextDocumentContentChangeEvent[];
  /** Target versioned document identifier. */
  readonly textDocument: LspVersionedTextDocumentIdentifier;
}

/** Parameters for `textDocument/didSave`. */
export interface LspDidSaveParams {
  /** Optional saved buffer snapshot (`includeText: true`). */
  readonly text?: string;
  /** Saved document identifier. */
  readonly textDocument: LspTextDocumentIdentifier;
}

/** Parameters for `textDocument/didClose`. */
export interface LspDidCloseParams {
  /** Closed document identifier. */
  readonly textDocument: LspTextDocumentIdentifier;
}

/** LSP 3.17 `FileChangeType` (`1 = Created`, `2 = Changed`, `3 = Deleted`). */
export type LspFileChangeType = 1 | 2 | 3;

/** Single watched filesystem event inside `workspace/didChangeWatchedFiles`. */
export interface LspFileEvent {
  /** Change classification (`1 = Created`, `2 = Changed`, `3 = Deleted`). */
  readonly type: LspFileChangeType;
  /** Affected `file://` URI. */
  readonly uri: string;
}

/** Parameters for `workspace/didChangeWatchedFiles`. */
export interface LspDidChangeWatchedFilesParams {
  /** Batched disk change events. */
  readonly changes: readonly LspFileEvent[];
}

// ------------------ Handshake & Capabilities ------------------

/** Workspace folder descriptor passed in `initialize.params.workspaceFolders`. */
export interface LspWorkspaceFolder {
  /** Display name of the workspace root. */
  readonly name: string;
  /** Canonical `file://` URI of the workspace root directory. */
  readonly uri: string;
}

/** Semantic token type and modifier legend advertised by `corex lsp`. */
export interface LspSemanticTokensLegend {
  /** Ordered bit-position modifier names (`0..14`). */
  readonly tokenModifiers: readonly string[];
  /** Ordered token type names (`0..19`). */
  readonly tokenTypes: readonly string[];
}

/** Full-document semantic token capability descriptor (`full.delta`). */
export interface LspSemanticTokensFullOptions {
  /** Whether incremental semantic token delta edits (`/full/delta`) are supported. */
  readonly delta?: boolean;
}

/** Semantic token server capability descriptor. */
export interface LspSemanticTokensOptions {
  /** Full-document semantic token support (with optional `delta` support). */
  readonly full?: boolean | LspSemanticTokensFullOptions;
  /** Token type and modifier legend. */
  readonly legend: LspSemanticTokensLegend;
  /** Viewport range semantic token support. */
  readonly range?: boolean;
}

/** Pull-diagnostics capability options advertised by `corex lsp`. */
export interface LspDiagnosticOptions {
  /** Whether editing one file may affect diagnostics in dependent files. */
  readonly interFileDependencies?: boolean;
  /** Whether `workspace/diagnostic` is supported. */
  readonly workspaceDiagnostics?: boolean;
}

/** Completion provider options advertised by `corex lsp`. */
export interface LspCompletionOptions {
  /** Whether `completionItem/resolve` is supported. */
  readonly resolveProvider?: boolean;
  /** Single-character completion triggers (`['.', '@', ':']`). */
  readonly triggerCharacters?: readonly string[];
}

/** Signature help provider options advertised by `corex lsp`. */
export interface LspSignatureHelpOptions {
  /** Characters that re-trigger signature help while already active (`[',']`). */
  readonly retriggerCharacters?: readonly string[];
  /** Characters that open signature help (`['(', ',', '[']`). */
  readonly triggerCharacters?: readonly string[];
}

/** Code action server capability options advertised by `corex lsp`. */
export interface LspCodeActionOptions {
  /** Supported code action kinds (e.g., `['quickfix']`). */
  readonly codeActionKinds?: readonly string[];
}

/** Rename server capability options advertised by `corex lsp`. */
export interface LspRenameOptions {
  /** Whether `textDocument/prepareRename` validation is supported before `rename`. */
  readonly prepareProvider?: boolean;
}

/** Server capabilities returned by `corex lsp` during `initialize`. */
export interface LspServerCapabilities {
  /** Quick-fix code action support. */
  readonly codeActionProvider?: boolean | LspCodeActionOptions;
  /** Dot, `@`, and lexical completion support. */
  readonly completionProvider?: LspCompletionOptions;
  /** Go-to-definition support. */
  readonly definitionProvider?: boolean;
  /** LSP 3.17 pull diagnostics support. */
  readonly diagnosticProvider?: LspDiagnosticOptions;
  /** Whole-document `corex fmt` formatting support. */
  readonly documentFormattingProvider?: boolean;
  /** Intra-file read/write occurrence highlight support. */
  readonly documentHighlightProvider?: boolean;
  /** Range `corex fmt` formatting support. */
  readonly documentRangeFormattingProvider?: boolean;
  /** Hierarchical outline symbol support. */
  readonly documentSymbolProvider?: boolean;
  /** Hover signature, contract, and documentation support. */
  readonly hoverProvider?: boolean;
  /** Inferred type, parameter, and contract inlay hint support. */
  readonly inlayHintProvider?: boolean;
  /** Negotiated column offset encoding (`'utf-16'` or `'utf-8'`). */
  readonly positionEncoding?: LspPositionEncoding;
  /** Visibility-pruned find-references support. */
  readonly referencesProvider?: boolean;
  /** Cross-file hygiene-checked rename support. */
  readonly renameProvider?: boolean | LspRenameOptions;
  /** Full, delta, and range semantic token support. */
  readonly semanticTokensProvider?: LspSemanticTokensOptions;
  /** Call-site signature help support. */
  readonly signatureHelpProvider?: LspSignatureHelpOptions;
  /** Document sync configuration. */
  readonly textDocumentSync?: unknown;
  /** Go-to-type-definition support. */
  readonly typeDefinitionProvider?: boolean;
  /** Fuzzy workspace symbol search support. */
  readonly workspaceSymbolProvider?: boolean;
}

/** Server identity metadata returned in `InitializeResult.serverInfo`. */
export interface LspServerInfo {
  /** Server name (`'corex-lsp'`). */
  readonly name: string;
  /** Optional server version string. */
  readonly version?: string;
}

/** Result payload returned by the `initialize` handshake request. */
export interface LspInitializeResult {
  /** Negotiated server capabilities. */
  readonly capabilities: LspServerCapabilities;
  /** Optional server name and version metadata. */
  readonly serverInfo?: LspServerInfo;
}

// ------------------------ Diagnostics -------------------------

/** LSP 3.17 1-based `DiagnosticSeverity` (`1 = Error`, `2 = Warning`, `3 = Info`, `4 = Hint`). */
export type LspDiagnosticSeverity = 1 | 2 | 3 | 4;

/** LSP 3.17 1-based `DiagnosticTag` (`1 = Unnecessary`, `2 = Deprecated`). */
export type LspDiagnosticTag = 1 | 2;

/** Secondary labeled span attached to an `LspDiagnostic`. */
export interface LspDiagnosticRelatedInformation {
  /** Secondary span location (potentially in another file). */
  readonly location: LspLocation;
  /** Explanatory label for the secondary span. */
  readonly message: string;
}

/** Single compiler or SAST diagnostic emitted by `corex lsp`. */
export interface LspDiagnostic {
  /** Canonical CoreX diagnostic code (e.g., `'E0301'`, `'W0402'`). */
  readonly code?: string | number;
  /** Primary diagnostic message (including `• ` note bullets). */
  readonly message: string;
  /** Primary source span in the target document. */
  readonly range: LspRange;
  /** Secondary labeled spans providing additional context. */
  readonly relatedInformation?: readonly LspDiagnosticRelatedInformation[];
  /** 1-based LSP severity (`1..4`; subtract `1` for `vscode.DiagnosticSeverity`). */
  readonly severity?: LspDiagnosticSeverity;
  /** Diagnostic origin (`'corex'`). */
  readonly source?: string;
  /** Optional 1-based diagnostic tags (`1 = Unnecessary`, `2 = Deprecated`). */
  readonly tags?: readonly LspDiagnosticTag[];
}

/** Inbound `textDocument/publishDiagnostics` notification payload. */
export interface LspPublishDiagnosticsParams {
  /** Current diagnostics for `uri`. */
  readonly diagnostics: readonly LspDiagnostic[];
  /** Target `file://` document URI. */
  readonly uri: string;
  /** Optional buffer version corresponding to `diagnostics`. */
  readonly version?: number;
}

/** Full pull-diagnostic report (`kind: 'full'`) from `textDocument/diagnostic`. */
export interface LspFullDocumentDiagnosticReport {
  /** Complete diagnostic list for the requested document. */
  readonly items: readonly LspDiagnostic[];
  /** Discriminant tag for a full diagnostic payload. */
  readonly kind: 'full';
  /** Optional 32-hex `Fingerprint128` cache token. */
  readonly resultId?: string;
}

/** Unchanged pull-diagnostic report (`kind: 'unchanged'`) from `textDocument/diagnostic`. */
export interface LspUnchangedDocumentDiagnosticReport {
  /** Discriminant tag indicating diagnostics match `previousResultId`. */
  readonly kind: 'unchanged';
  /** Matching 32-hex `Fingerprint128` cache token. */
  readonly resultId: string;
}

/** Discriminated union returned by `textDocument/diagnostic`. */
export type LspDocumentDiagnosticReport =
  | LspFullDocumentDiagnosticReport
  | LspUnchangedDocumentDiagnosticReport;

// ---------------------- Semantic Tokens -----------------------

/** Full or range 5-integer-per-token delta-encoded semantic token payload. */
export interface LspSemanticTokens {
  /** Flat `[deltaLine, deltaStart, length, tokenType, tokenModifiers, …]` array. */
  readonly data: readonly number[];
  /** Optional 16-hex snapshot identifier for subsequent `/full/delta` requests. */
  readonly resultId?: string;
}

/** Single array splice instruction inside `LspSemanticTokensDelta`. */
export interface LspSemanticTokensEdit {
  /** Replacement integer slice inserted at `start`. */
  readonly data?: readonly number[];
  /** Number of integers to remove starting at `start`. */
  readonly deleteCount: number;
  /** Start index in the previous `data` array. */
  readonly start: number;
}

/** Incremental semantic token delta response from `textDocument/semanticTokens/full/delta`. */
export interface LspSemanticTokensDelta {
  /** Ordered array edits transforming the previous token array into the current one. */
  readonly edits: readonly LspSemanticTokensEdit[];
  /** Updated 16-hex snapshot identifier. */
  readonly resultId?: string;
}

/** Union returned by `textDocument/semanticTokens/full/delta` (delta hit or full cache-miss fallback). */
export type LspSemanticTokensDeltaResult = LspSemanticTokens | LspSemanticTokensDelta;

// ------------------- Language Intelligence --------------------

/** Markdown or plaintext content block used in hover and documentation fields. */
export interface LspMarkupContent {
  /** Content format (`'markdown'` or `'plaintext'`). */
  readonly kind: 'markdown' | 'plaintext';
  /** Raw text or Markdown source. */
  readonly value: string;
}

/** Result of `textDocument/hover`. */
export interface LspHover {
  /** Hover Markdown signature, contract bullets, and documentation. */
  readonly contents: LspMarkupContent | string;
  /** Optional focal token span highlighted by the hover card. */
  readonly range?: LspRange;
}

/** LSP 3.17 1-based `DocumentHighlightKind` (`1 = Text`, `2 = Read`, `3 = Write`). */
export type LspDocumentHighlightKind = 1 | 2 | 3;

/** Intra-document symbol occurrence returned by `textDocument/documentHighlight`. */
export interface LspDocumentHighlight {
  /** 1-based access kind (`1..3`; subtract `1` for `vscode.DocumentHighlightKind`). */
  readonly kind?: LspDocumentHighlightKind;
  /** Occurrence range within the active document. */
  readonly range: LspRange;
}

/** LSP 3.17 1-based `SymbolTag` (`1 = Deprecated`). */
export type LspSymbolTag = 1;

/** Hierarchical outline symbol node returned by `textDocument/documentSymbol`. */
export interface LspDocumentSymbol {
  /** Nested member symbols (fields, variants, methods, inline module items). */
  readonly children?: readonly LspDocumentSymbol[];
  /** Optional type or signature detail string. */
  readonly detail?: string;
  /** 1-based LSP `SymbolKind` (`1..26`; subtract `1` for `vscode.SymbolKind`). */
  readonly kind: number;
  /** Display name of the symbol. */
  readonly name: string;
  /** Enclosing declaration range. */
  readonly range: LspRange;
  /** Identifier token range strictly contained within `range`. */
  readonly selectionRange: LspRange;
  /** Optional 1-based symbol tags (`[1]` when `@deprecated`). */
  readonly tags?: readonly LspSymbolTag[];
}

/** Flat workspace symbol record returned by `workspace/symbol`. */
export interface LspSymbolInformation {
  /** Optional enclosing module or nominal type name. */
  readonly containerName?: string;
  /** 1-based LSP `SymbolKind` (`1..26`; subtract `1` for `vscode.SymbolKind`). */
  readonly kind: number;
  /** Declaration location in the workspace. */
  readonly location: LspLocation;
  /** Symbol identifier name. */
  readonly name: string;
  /** Optional 1-based symbol tags (`[1]` when `@deprecated`). */
  readonly tags?: readonly LspSymbolTag[];
}

/** LSP 3.17 1-based `CompletionItemTag` (`1 = Deprecated`). */
export type LspCompletionItemTag = 1;

/** Single completion candidate inside `LspCompletionList`. */
export interface LspCompletionItem {
  /** Optional concise type or signature detail. */
  readonly detail?: string;
  /** Optional documentation string or Markdown block. */
  readonly documentation?: string | LspMarkupContent;
  /** Optional replacement text when different from `label`. */
  readonly insertText?: string;
  /** 1-based LSP `CompletionItemKind` (`1..25`; subtract `1` for `vscode.CompletionItemKind`). */
  readonly kind?: number;
  /** Primary completion label inserted on acceptance. */
  readonly label: string;
  /** Optional 1-based completion tags (`[1]` when `@deprecated`). */
  readonly tags?: readonly LspCompletionItemTag[];
  /** Optional explicit range replacement edit. */
  readonly textEdit?: LspTextEdit;
}

/** Completion list returned by `textDocument/completion`. */
export interface LspCompletionList {
  /** Whether typing additional characters may yield further candidates (`>= 256` cap). */
  readonly isIncomplete: boolean;
  /** Pre-ranked completion candidates. */
  readonly items: readonly LspCompletionItem[];
}

/** Single parameter descriptor inside `LspSignatureInformation`. */
export interface LspParameterInformation {
  /** Optional parameter documentation. */
  readonly documentation?: string | LspMarkupContent;
  /** Parameter label substring or `[start, end)` offset pair within the signature label. */
  readonly label: string | readonly [number, number];
}

/** Candidate function or `@overload` signature inside `LspSignatureHelp`. */
export interface LspSignatureInformation {
  /** Candidate-specific active parameter index. */
  readonly activeParameter?: number;
  /** Optional function documentation. */
  readonly documentation?: string | LspMarkupContent;
  /** Formatted CoreX function signature label. */
  readonly label: string;
  /** Ordered visible parameter labels. */
  readonly parameters?: readonly LspParameterInformation[];
}

/** Call-site signature help payload returned by `textDocument/signatureHelp`. */
export interface LspSignatureHelp {
  /** Fallback active parameter index (`0`-based). */
  readonly activeParameter?: number;
  /** Active overload signature index (`0`-based). */
  readonly activeSignature?: number;
  /** Candidate function signatures (`>= 1`). */
  readonly signatures: readonly LspSignatureInformation[];
}

/** LSP 3.17 1-based `InlayHintKind` (`1 = Type`, `2 = Parameter`). */
export type LspInlayHintKind = 1 | 2;

/** Inlay hint item returned by `textDocument/inlayHint`. */
export interface LspInlayHint {
  /** Optional 1-based inlay hint kind (`1 = Type`, `2 = Parameter`; omitted on contract hints). */
  readonly kind?: LspInlayHintKind;
  /** Rendered hint label (e.g., `': i32'`, `'count:'`, or inferred `@no_alloc` contract note). */
  readonly label: string;
  /** Whether to render spacing before `label`. */
  readonly paddingLeft?: boolean;
  /** Whether to render spacing after `label`. */
  readonly paddingRight?: boolean;
  /** Anchor position in the document. */
  readonly position: LspPosition;
  /** Optional click-to-insert edits (emitted on inferred `: <Type>` hints). */
  readonly textEdits?: readonly LspTextEdit[];
  /** Optional hover tooltip for the hint. */
  readonly tooltip?: string | LspMarkupContent;
}

/** Quick-fix code action returned by `textDocument/codeAction`. */
export interface LspCodeAction {
  /** Diagnostics resolved by this quick-fix. */
  readonly diagnostics?: readonly LspDiagnostic[];
  /** Workspace edit applying the compiler's `SuggestedFix`. */
  readonly edit?: LspWorkspaceEdit;
  /** Whether this fix is machine-applicable (`FixApplicability.machine_applicable`). */
  readonly isPreferred?: boolean;
  /** Code action kind (`'quickfix'`). */
  readonly kind?: string;
  /** Human-readable fix description. */
  readonly title: string;
}

/** Editor indentation options passed to `textDocument/formatting` and `rangeFormatting`. */
export interface LspFormattingOptions {
  /** Whether spaces are preferred over tabs (`true` for canonical CoreX 4-space style). */
  readonly insertSpaces: boolean;
  /** Tab width in spaces (`4`). */
  readonly tabSize: number;
}

/** Validation range and placeholder returned by `textDocument/prepareRename`. */
export interface LspPrepareRenameResult {
  /** Current identifier spelling pre-filled in the rename input box. */
  readonly placeholder: string;
  /** Exact identifier token range to replace. */
  readonly range: LspRange;
}

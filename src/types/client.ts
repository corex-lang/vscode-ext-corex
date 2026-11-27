/**
 * Client Types – Host-agnostic interfaces for the `corex lsp` and `corex fmt` transport layer.
 *
 * Defines structural cancellation tokens (`RequestCancelToken`), framing parser state,
 * JSON-RPC error objects, and `LspClientSession` lifecycle contracts without importing `vscode`.
 *
 * `vscode.CancellationToken` satisfies `RequestCancelToken` structurally with zero adapters.
 */

import type { TraceServerMode } from './config';
import type {
  LspInitializeResult,
  LspPositionEncoding,
  LspPublishDiagnosticsParams,
  LspWorkspaceFolder,
} from './lsp';

// ---------------------------------------- TYPES ----------------------------------------

/** Host-agnostic disposable handle compatible with `vscode.Disposable`. */
export interface DisposableLike {
  /** Releases the underlying listener or subscription. */
  readonly dispose: () => unknown;
}

/** Structural cancellation token satisfied natively by `vscode.CancellationToken`. */
export interface RequestCancelToken {
  /** Whether cancellation has already been requested. */
  readonly isCancellationRequested: boolean;
  /** Registers `listener` to run when cancellation is triggered. */
  readonly onCancellationRequested: (listener: () => void) => DisposableLike;
}

/** Structured `Error` object produced when `corex lsp` returns a JSON-RPC 2.0 error response. */
export interface JsonRpcRequestError extends Error {
  /** JSON-RPC 2.0 or LSP 3.17 negative integer error code (e.g., `-32802`, `-32803`). */
  readonly code: number;
  /** Optional structured error data payload. */
  readonly data?: unknown;
  /** Discriminant tag enabling `isJsonRpcRequestError` narrowing without `class` inheritance. */
  readonly isJsonRpcError: true;
}

/** Mutable byte-stream state for the non-backtracking `Content-Length` frame decoder. */
export interface FrameDecoderState {
  /** Declared byte length of the current frame body (`null` while scanning headers). */
  parsedContentLength: number | null;
  /** Current unread byte offset inside `rxBuffer`. */
  readOffset: number;
  /** Contiguous backing `Buffer` accumulating raw `stdout` chunks prior to UTF-8 decoding. */
  rxBuffer: Buffer;
  /** Exclusive end byte offset of valid unread bytes inside `rxBuffer`. */
  writeOffset: number;
}

/** Successfully extracted UTF-8 JSON-RPC message payload from `feedFrameChunk`. */
export interface DecodedFrameMessage {
  /** Discriminant tag for a complete framed JSON payload. */
  readonly kind: 'message';
  /** Complete UTF-8 decoded JSON body of exact byte length `Content-Length`. */
  readonly payload: string;
}

/** Bounded-resource or malformed-header error reported by `feedFrameChunk`. */
export interface DecodedFrameError {
  /** Whether stream synchronization was lost (e.g., oversized header/body requiring reset). */
  readonly isFatalStreamDesync: boolean;
  /** Discriminant tag for a framing violation. */
  readonly kind: 'error';
  /** Diagnostic description of the framing violation. */
  readonly message: string;
  /** Machine-readable violation category. */
  readonly reason: 'header-too-large' | 'invalid-header' | 'payload-too-large';
}

/** Event item returned by `feedFrameChunk`. */
export type DecodedFrameEvent = DecodedFrameMessage | DecodedFrameError;

/** Lifecycle state of a spawned `corex lsp` client session. */
export type LspClientState = 'starting' | 'running' | 'stopping' | 'stopped';

/** Startup configuration and callbacks passed to `startLspClient`. */
export interface LspClientOptions {
  /** Validated filesystem path to the `corex` executable. */
  readonly binaryPath: string;
  /** Optional working directory for the `corex lsp` child process. */
  readonly cwd?: string;
  /** Optional environment variable overrides for the child process. */
  readonly env?: NodeJS.ProcessEnv;
  /** Whether to pass `--internal-core` to `corex lsp --stdio`. */
  readonly isInternalCore?: boolean;
  /** Invoked when the `corex lsp` child process exits. */
  readonly onExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
    isUnexpected: boolean
  ) => void;
  /** Invoked when a framing or malformed JSON-RPC protocol error occurs. */
  readonly onProtocolError?: (message: string, error?: unknown) => void;
  /** Invoked on inbound `textDocument/publishDiagnostics` notifications. */
  readonly onPublishDiagnostics?: (params: LspPublishDiagnosticsParams) => void;
  /** Invoked for each line written by `corex lsp` to `stderr`. */
  readonly onStderr?: (line: string) => void;
  /** Invoked for JSON-RPC trace logging when `traceMode !== 'off'`. */
  readonly onTrace?: (direction: 'send' | 'receive', summary: string, payload?: string) => void;
  /** Preferred position encoding (`'utf-16'` by default for VS Code UTF-16 `Position`s). */
  readonly positionEncoding?: LspPositionEncoding;
  /** Per-request timeout ceiling (ms; defaults to `15_000`). */
  readonly requestTimeoutMs?: number;
  /** Optional `rootUri` passed in `initialize` (`workspaceFolders[0].uri` used when omitted). */
  readonly rootUri?: string | null;
  /** Initial `$/setTrace` verbosity (`'off'` by default). */
  readonly traceMode?: TraceServerMode;
  /** Workspace root folders advertised during `initialize`. */
  readonly workspaceFolders?: readonly LspWorkspaceFolder[];
}

/** Public handle representing a live or terminated `corex lsp` session. */
export interface LspClientSession {
  /** Returns the current `LspClientState` (`'running'`, `'stopping'`, `'stopped'`). */
  readonly getState: () => LspClientState;
  /** Server `InitializeResult` capabilities and version metadata. */
  readonly initializeResult: LspInitializeResult;
  /** Returns `true` when the child process is initialized and accepting requests. */
  readonly isRunning: () => boolean;
  /** Negotiated column encoding (`'utf-16'` or `'utf-8'`). */
  readonly negotiatedEncoding: LspPositionEncoding;
  /** Sends a JSON-RPC 2.0 notification frame, returning `true` when queued to `stdin`. */
  readonly notify: (method: string, params?: unknown) => boolean;
  /** Child OS process identifier (`undefined` if spawn failed). */
  readonly pid: number | undefined;
  /** Sends a JSON-RPC 2.0 request frame and resolves with the untrusted `result` payload. */
  readonly request: (
    method: string,
    params: unknown,
    token?: RequestCancelToken
  ) => Promise<unknown>;
  /** Updates the local trace verbosity and forwards `$/setTrace` if running. */
  readonly setTraceMode: (mode: TraceServerMode) => void;
  /** Gracefully stops `corex lsp` (`shutdown` -> `exit` -> `stdin.end()` -> `500 ms` kill). */
  readonly stop: () => Promise<void>;
}

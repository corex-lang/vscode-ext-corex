/**
 * LSP & Formatter Client – Zero-dependency JSON-RPC 2.0 `stdio` client and `corex fmt` runner.
 *
 * Implements non-backtracking `Buffer`-level `Content-Length` framing, bounded pending-request
 * multiplexing, `$/cancelRequest` forwarding, `32 MiB` outbound stream backpressure enforcement,
 * graceful/forced `corex lsp` shutdown, `corex fmt` temp-file fallback, and UTF-16 diffing.
 *
 * Contains zero `vscode` runtime imports so headless `vitest` suites run directly in Node.
 */

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathJoin } from '@/binary';
import type {
  DecodedFrameError,
  DecodedFrameEvent,
  DisposableLike,
  FrameDecoderState,
  JsonRpcId,
  JsonRpcRequestError,
  LspClientOptions,
  LspClientSession,
  LspClientState,
  LspInitializeResult,
  LspPosition,
  LspPublishDiagnosticsParams,
  LspTextEdit,
  RequestCancelToken,
  TraceServerMode,
} from '@/types';

// ---------------------------------------- TYPES ----------------------------------------

/** Compact in-flight request tuple: `[resolve, reject, timer, cancelSub]`. */
type PendingEntry = readonly [
  (value: unknown) => void,
  (reason: Error) => void,
  ReturnType<typeof setTimeout>,
  DisposableLike | undefined,
];

// --------------------------------------- CONSTS ----------------------------------------

/** Shared alias binding `Array.isArray` to a mangleable identifier. */
export const { isArray } = Array;

/** Shared UTF-8 byte-length helper bound to `Buffer.byteLength`. */
export const utf8ByteLen: (text: string) => number = Buffer.byteLength;

/** Ordered client lifecycle state names indexed by numeric phase (`0..3`). */
const CLIENT_STATES = 'starting,running,stopping,stopped'.split(',') as readonly LspClientState[];

/** CLI flag unlocking compiler-internal `@intrinsic` primitives. */
export const INTERNAL_CORE_FLAG = '--internal-core';

/** Maximum byte length of an HTTP-style LSP frame header block (bytes; 8 KiB). */
export const MAX_LSP_HEADER_BYTES = 8192;

/** Maximum byte length of a single JSON-RPC 2.0 message payload (bytes; 16 MiB). */
export const MAX_LSP_CONTENT_LENGTH = 16_777_216;

/** Maximum byte length of a single document `file://` URI (bytes; 4 KiB). */
export const MAX_LSP_URI_BYTES = 4096;

/** Maximum concurrent in-flight JSON-RPC requests before fast-failing. */
export const MAX_PENDING_REQUESTS = 512;

/** Initial `rxBuffer` allocation size and post-spike idle shrink target (bytes; 64 KiB). */
export const INITIAL_RX_BUFFER_BYTES = 65_536;

/** Idle `rxBuffer` threshold above which the buffer shrinks back to `64 KiB` (bytes; 1 MiB). */
const SHRINK_IDLE_BUFFER_THRESHOLD = 1_048_576;

/** Maximum bytes buffered in `child.stdin` during backpressure (bytes; 32 MiB). */
const MAX_OUTBOUND_QUEUE_SIZE = 33_554_432;

/** Maximum recent `stderr` lines retained for crash diagnostics. */
const MAX_RECENT_STDERR_LINES = 24;

/** Default per-request JSON-RPC timeout (ms). */
const DEFAULT_REQUEST_TIMEOUT = 15_000;

/** Graceful `shutdown` request timeout before proceeding to `exit` (ms). */
const SHUTDOWN_TIMEOUT = 2000;

/** Grace period after `exit` before force-killing `corex lsp` so binaries unlock on Windows (ms). */
const EXIT_KILL_GRACE_TIMEOUT = 500;

/** Post-`SIGKILL` wait ceiling for `'close'` so Windows releases `SEC_IMAGE` locks (ms). */
const POST_KILL_CLOSE_TIMEOUT = 250;

/** Execution timeout for standalone `corex fmt` CLI invocations (ms). */
const FMT_CLI_TIMEOUT = 5000;

/** JSON-RPC 2.0 parse error code (`-32700`). */
export const JSONRPC_PARSE_ERROR = -32_700;

/** JSON-RPC 2.0 invalid request error code (`-32600`). */
export const JSONRPC_INVALID_REQUEST = -32_600;

/** JSON-RPC 2.0 method not found error code (`-32601`). */
export const JSONRPC_METHOD_NOT_FOUND = -32_601;

/** JSON-RPC 2.0 invalid parameters error code (`-32602`). */
export const JSONRPC_INVALID_PARAMS = -32_602;

/** JSON-RPC 2.0 internal error code (`-32603`). */
export const JSONRPC_INTERNAL_ERROR = -32_603;

/** LSP 3.17 server not initialized error code (`-32002`). */
export const LSP_SERVER_NOT_INITIALIZED = -32_002;

/** LSP 3.17 semantic or hygiene request failure code (`-32803`). */
export const LSP_REQUEST_FAILED = -32_803;

/** LSP 3.17 server-initiated cancellation error code (`-32802`). */
export const LSP_SERVER_CANCELLED = -32_802;

/** LSP 3.17 content modified error code (`-32801`). */
export const LSP_CONTENT_MODIFIED = -32_801;

/** LSP 3.17 client-initiated `$/cancelRequest` error code (`-32800`). */
export const LSP_REQUEST_CANCELLED = -32_800;

// ----------------------------------- REGEX PATTERNS ------------------------------------

/** Matches non-empty unsigned ASCII decimal integers without backtracking. */
const ASCII_DIGITS_RX = /^\d+$/;

/** Matches `LF` or `CRLF` line terminators without backtracking. */
const LINE_SPLIT_RX = /\r?\n/;

/** Matches the blank-line separator ending an HTTP-style LSP frame header without backtracking. */
const HEADER_SEP_RX = /\r?\n\r?\n/;

/** Matches a partial frame-header separator suffix at chunk end without backtracking. */
const PARTIAL_SEP_RX = /\r\n\r$|\r?\n\r?$|\r$/;

// -------------------------------------- INTERNALS --------------------------------------

// ------------------------ Type Guards -------------------------

/**
 * Checks whether `token` has requested cancellation.
 *
 * @param token   Optional structural cancellation token.
 */
function isCancelled(token?: RequestCancelToken): boolean {
  return Boolean(token?.isCancellationRequested);
}

/**
 * Returns `true` when `value` is a `string`.
 *
 * @param value   Untrusted value to inspect.
 */
export function isStr(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Returns `true` when `value` is a non-null, non-array plain object record.
 *
 * @param value   Untrusted value to inspect.
 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !isArray(value);
}

/**
 * Returns `true` when `value` is a finite JSON-RPC `number` or bounded `<= 1024` char `string`.
 *
 * @param value   Untrusted `id` property.
 */
function isRpcId(value: unknown): value is JsonRpcId {
  return (
    (typeof value === 'number' && Number.isFinite(value)) || (isStr(value) && value.length <= 1024)
  );
}

/**
 * Creates a structured `JsonRpcRequestError` without `class` declarations.
 *
 * @param code      JSON-RPC 2.0 or LSP 3.17 integer error code.
 * @param message   Human-readable error description.
 * @param data      Optional structured error data.
 */
function createRpcError(code: number, message: string, data?: unknown): JsonRpcRequestError {
  return Object.assign(new Error(message), { code, data, isJsonRpcError: true as const });
}

/**
 * Narrows an untrusted JSON-RPC `error` property into a `JsonRpcRequestError`.
 *
 * @param rpcErr   Untrusted `msg.error` payload.
 */
function toRpcError(rpcErr: unknown): JsonRpcRequestError {
  return isRecord(rpcErr) && typeof rpcErr.code === 'number' && isStr(rpcErr.message)
    ? createRpcError(rpcErr.code, rpcErr.message, rpcErr.data)
    : createRpcError(JSONRPC_INTERNAL_ERROR, 'Error');
}

/**
 * Returns `true` when `uri` is a non-empty string within `MAX_LSP_URI_BYTES` (`4096`).
 *
 * @param uri   Untrusted document URI value.
 */
export function isValidUri(uri: unknown): uri is string {
  if (!isStr(uri)) {
    return false;
  }
  const byteLen = utf8ByteLen(uri);
  return byteLen > 0 && byteLen <= MAX_LSP_URI_BYTES;
}

// ----------------------- Buffer Framing -----------------------

/**
 * Appends a `DecodedFrameError` record to `events`.
 *
 * @param events    Frame event accumulator.
 * @param reason    Framing violation category.
 * @param isFatal   Whether stream synchronization was lost.
 */
function pushFrameError(
  events: DecodedFrameEvent[],
  reason: DecodedFrameError['reason'],
  isFatal: boolean
): void {
  events.push({ isFatalStreamDesync: isFatal, kind: 'error', message: reason, reason });
}

/**
 * Returns `true` when an incomplete header window has exceeded `MAX_LSP_HEADER_BYTES` (`8 KiB`).
 *
 * @param headerWindow   Decoded `'latin1'` header prefix window.
 * @param unreadBytes    Total unread bytes currently buffered in `state`.
 * @param sepMatch       Full blank-line separator match, if found.
 */
function hasHeaderOverflow(
  headerWindow: string,
  unreadBytes: number,
  sepMatch: RegExpExecArray | null
): boolean {
  return (
    sepMatch !== null ||
    (unreadBytes > MAX_LSP_HEADER_BYTES &&
      (unreadBytes > MAX_LSP_HEADER_BYTES + 3 ||
        (PARTIAL_SEP_RX.exec(headerWindow)?.index ?? MAX_LSP_CONTENT_LENGTH) >
          MAX_LSP_HEADER_BYTES))
  );
}

/**
 * Parses an HTTP-style header block (`Content-Length` + optional `Content-Type`), returning `-1` when invalid or `-2` when oversized.
 *
 * @param headerText   `'latin1'` header block preceding the blank-line separator.
 */
function parseContentLength(headerText: string): number {
  let found = -1;
  for (const rawLine of headerText.split(LINE_SPLIT_RX)) {
    const line = rawLine.trim();
    if (line) {
      const colon = line.indexOf(':');
      if (colon <= 0) {
        return -1;
      }
      if (line.slice(0, colon).trim().toLowerCase() === 'content-length') {
        const valText = line.slice(colon + 1).trim();
        const parsed = ASCII_DIGITS_RX.test(valText) ? Number(valText) : -1;
        if (parsed < 0 || (found !== -1 && found !== parsed)) {
          return -1;
        }
        found = parsed;
      }
    }
  }
  return found > MAX_LSP_CONTENT_LENGTH ? -2 : found;
}

// ------------------ Transport & UTF-16 Diff -------------------

/**
 * Serializes `message` into UTF-8 JSON text and a `Content-Length` framed `Buffer`.
 *
 * @param message   JSON-RPC 2.0 object.
 */
function packJsonRpc(message: object): readonly [Buffer, string] {
  const jsonText = JSON.stringify(message);
  const bodyBytes = utf8ByteLen(jsonText);
  if (bodyBytes > MAX_LSP_CONTENT_LENGTH) {
    throw createRpcError(JSONRPC_INVALID_REQUEST, 'Payload > 16 MiB');
  }
  return [Buffer.from(`Content-Length: ${bodyBytes}\r\n\r\n${jsonText}`), jsonText];
}

/**
 * Returns `true` when `splitIdx` inside `text` tears a UTF-16 surrogate pair or `\r\n` pair.
 *
 * @param text       UTF-16 source or formatted string.
 * @param splitIdx   Candidate split index (`1..text.length`).
 */
function hasSplitPair(text: string, splitIdx: number): boolean {
  const left = text.charCodeAt(splitIdx - 1);
  const right = text.charCodeAt(splitIdx);
  return (
    (left >= 55_296 && left <= 56_319 && right >= 56_320 && right <= 57_343) ||
    (left === 13 && right === 10)
  );
}

// ------------------------------------- PUBLIC API --------------------------------------

// -------------------- Framing & Lifecycle ---------------------

/**
 * Returns `true` when `value` is a plain object whose property `key` is an `Array`.
 *
 * @param value   Untrusted value to inspect.
 * @param key     Property name expected to hold an array.
 */
export function hasArrayProp(
  value: unknown,
  key: string
): value is Readonly<Record<string, unknown>> {
  return isRecord(value) && isArray(value[key]);
}

/**
 * Type guard checking whether `error` is a structured `JsonRpcRequestError`.
 *
 * @param error   Untrusted caught exception.
 */
export function isJsonRpcRequestError(error: unknown): error is JsonRpcRequestError {
  return error instanceof Error && (error as Partial<JsonRpcRequestError>).isJsonRpcError === true;
}

/**
 * Allocates a fresh `FrameDecoderState` with contiguous `Buffer` storage.
 *
 * @param initialCapacity   Initial receive buffer size (bytes; defaults to `64 KiB`).
 */
export function createFrameDecoderState(
  initialCapacity: number = INITIAL_RX_BUFFER_BYTES
): FrameDecoderState {
  return {
    parsedContentLength: null,
    readOffset: 0,
    rxBuffer: Buffer.allocUnsafe(Math.max(initialCapacity, 64)),
    writeOffset: 0,
  };
}

/**
 * Appends `chunk` to `state` and extracts all complete JSON-RPC 2.0 frames without partial UTF-8 decoding.
 *
 * @param state   Mutable frame decoder state.
 * @param chunk   Raw `stdout` byte chunk.
 */
export function feedFrameChunk(state: FrameDecoderState, chunk: Buffer): DecodedFrameEvent[] {
  let {
    parsedContentLength: bodyLen,
    readOffset: readOff,
    rxBuffer: rxBuf,
    writeOffset: writeOff,
  } = state;

  if (chunk.length > 0) {
    if (writeOff + chunk.length > rxBuf.length && readOff > 0) {
      rxBuf.copyWithin(0, readOff, writeOff);
      writeOff -= readOff;
      readOff = 0;
    }
    const needed = writeOff + chunk.length;
    if (needed > rxBuf.length) {
      const grown = Buffer.allocUnsafe(Math.max(rxBuf.length * 2, needed));
      rxBuf.copy(grown, 0, 0, writeOff);
      rxBuf = grown;
    }
    chunk.copy(rxBuf, writeOff);
    writeOff = needed;
  }

  const events: DecodedFrameEvent[] = [];
  while (readOff < writeOff) {
    if (bodyLen === null) {
      const headerWindow = rxBuf.toString(
        'latin1',
        readOff,
        Math.min(writeOff, readOff + MAX_LSP_HEADER_BYTES + 4)
      );
      const match = HEADER_SEP_RX.exec(headerWindow);
      if (match === null || match.index > MAX_LSP_HEADER_BYTES) {
        if (hasHeaderOverflow(headerWindow, writeOff - readOff, match)) {
          pushFrameError(events, 'header-too-large', true);
          readOff = writeOff;
        }
        break;
      }
      readOff += match.index + match[0].length;
      const parsed = parseContentLength(headerWindow.slice(0, match.index));
      if (parsed < 0) {
        const isTooLarge = parsed === -2;
        pushFrameError(events, isTooLarge ? 'payload-too-large' : 'invalid-header', isTooLarge);
        if (isTooLarge) {
          readOff = writeOff;
          break;
        }
      } else {
        bodyLen = parsed;
      }
    }
    if (bodyLen !== null) {
      if (writeOff - readOff < bodyLen) {
        break;
      }
      const bodyEnd = readOff + bodyLen;
      events.push({ kind: 'message', payload: rxBuf.toString('utf8', readOff, bodyEnd) });
      readOff = bodyEnd;
      bodyLen = null;
    }
  }

  if (readOff === writeOff) {
    readOff = 0;
    writeOff = 0;
    if (rxBuf.length > SHRINK_IDLE_BUFFER_THRESHOLD) {
      rxBuf = Buffer.allocUnsafe(INITIAL_RX_BUFFER_BYTES);
    }
  }

  state.parsedContentLength = bodyLen;
  state.readOffset = readOff;
  state.rxBuffer = rxBuf;
  state.writeOffset = writeOff;
  return events;
}

/**
 * Serializes a JSON-RPC 2.0 object into a single `Content-Length` framed `Buffer`.
 *
 * @param message   JSON-RPC 2.0 request, notification, or response object.
 */
export function encodeJsonRpcFrame(message: object): Buffer {
  return packJsonRpc(message)[0];
}

/**
 * Spawns `corex lsp --stdio`, negotiates `initialize` capabilities, and returns a live `LspClientSession`.
 *
 * @param options   Binary path, workspace roots, `--internal-core` flag, and event hooks.
 */
export async function startLspClient(options: LspClientOptions): Promise<LspClientSession> {
  const { onProtocolError, onTrace } = options;
  const child = spawn(
    options.binaryPath,
    ['lsp', '--stdio', ...(options.isInternalCore ? [INTERNAL_CORE_FLAG] : [])],
    { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  const { stdin } = child;
  const decoder = createFrameDecoderState();
  const pending = new Map<JsonRpcId, PendingEntry>();
  const stderrTail: string[] = [];
  let phase: 0 | 1 | 2 | 3 = 0;
  let isExited = false;
  let isSuppressingExit = false;
  let nextReqId = 1;
  let stderrRem = '';
  let stopPromise: Promise<void> | undefined = undefined;
  let traceMode: TraceServerMode = options.traceMode ?? 'off';

  /** Removes and cleans up timer/cancellation state for `reqId`. */
  function takePending(reqId: JsonRpcId): PendingEntry | undefined {
    const entry = pending.get(reqId);
    if (entry !== undefined) {
      pending.delete(reqId);
      clearTimeout(entry[2]);
      entry[3]?.dispose();
    }
    return entry;
  }

  /** Rejects all currently pending requests with `reason`. */
  function rejectAll(reason: Error): void {
    for (const reqId of pending.keys()) {
      takePending(reqId)?.[1](reason);
    }
  }

  /** Resolves `true` if `child` emits `'close'` within `timeout` (ms), or `false` on timeout. */
  function waitForClose(timeout: number): Promise<boolean> {
    return isExited
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), timeout);
          child.once('close', () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
  }

  /** Sends `SIGKILL` to `child` and awaits `'close'` up to `POST_KILL_CLOSE_TIMEOUT`. */
  async function forceKill(): Promise<void> {
    child.kill('SIGKILL');
    await waitForClose(POST_KILL_CLOSE_TIMEOUT);
  }

  /** Emits a JSON-RPC trace event when `traceMode !== 'off'`. */
  function trace(direction: 'send' | 'receive', summary: string, jsonText: string): void {
    if (traceMode !== 'off') {
      onTrace?.(direction, summary, traceMode === 'verbose' ? jsonText : undefined);
    }
  }

  /** Frames and writes `message` to `stdin`, force-killing `child` if `> 32 MiB` is queued. */
  function sendFrame(message: object, traceLabel?: string): boolean {
    if (isExited || !stdin.writable) {
      return false;
    }
    const [frame, jsonText] = packJsonRpc(message);
    if (stdin.writableLength + frame.length > MAX_OUTBOUND_QUEUE_SIZE) {
      onProtocolError?.('Queue full');
      child.kill('SIGKILL');
      return false;
    }
    if (traceLabel !== undefined) {
      trace('send', traceLabel, jsonText);
    }
    stdin.write(frame);
    return true;
  }

  /** Sends a JSON-RPC 2.0 notification frame, returning `true` when queued to `stdin`. */
  function sendNotify(method: string, params?: unknown): boolean {
    if (phase === 1 || (phase === 2 && method === 'exit')) {
      try {
        return sendFrame({ jsonrpc: '2.0', method, params }, method);
      } catch (error: unknown) {
        onProtocolError?.(method, error);
      }
    }
    return false;
  }

  /** Sends a JSON-RPC 2.0 request frame with timeout and cancellation forwarding. */
  async function sendReq(
    method: string,
    params: unknown,
    token?: RequestCancelToken,
    internalTimeout?: number
  ): Promise<unknown> {
    if ((phase !== 1 && internalTimeout === undefined) || isCancelled(token)) {
      throw createRpcError(LSP_REQUEST_CANCELLED, 'Cancelled');
    }
    if (pending.size >= MAX_PENDING_REQUESTS) {
      throw createRpcError(LSP_REQUEST_FAILED, 'Busy');
    }

    const reqId = nextReqId;
    nextReqId += 1;

    return new Promise<unknown>((resolve, reject) => {
      if (!sendFrame({ id: reqId, jsonrpc: '2.0', method, params }, `${method} (${reqId})`)) {
        reject(createRpcError(LSP_REQUEST_CANCELLED, 'Closed'));
        return;
      }
      const cancelMethod = '$/cancelRequest';
      const timer = setTimeout(
        () => {
          if (takePending(reqId)) {
            sendNotify(cancelMethod, { id: reqId });
            reject(createRpcError(LSP_REQUEST_CANCELLED, `Timeout: ${method}`));
          }
        },
        internalTimeout || options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT
      );
      const cancelSub = token?.onCancellationRequested(() => {
        if (pending.has(reqId)) {
          sendNotify(cancelMethod, { id: reqId });
        }
      });
      pending.set(reqId, [resolve, reject, timer, cancelSub]);
    });
  }

  /** Splits incoming UTF-8 `stderr` chunks into bounded diagnostic lines (`<= 24` retained). */
  function flushStderr(incomingText: string, isClosing: boolean): void {
    const parts = (stderrRem + incomingText).split(LINE_SPLIT_RX);
    const tail = isClosing ? '' : (parts.pop() ?? '');
    stderrRem = tail.length > MAX_LSP_HEADER_BYTES ? (parts.push(tail), '') : tail;
    for (const rawLine of parts) {
      if (rawLine) {
        const line =
          rawLine.length > MAX_LSP_HEADER_BYTES
            ? `${rawLine.slice(0, MAX_LSP_HEADER_BYTES)}…`
            : rawLine;
        if (stderrTail.push(line) > MAX_RECENT_STDERR_LINES) {
          stderrTail.shift();
        }
        options.onStderr?.(line);
      }
    }
  }

  /** Finalizes child termination, rejecting in-flight requests and notifying `onExit`. */
  function finishExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    message: string
  ): void {
    if (isExited) {
      return;
    }
    const prevPhase = phase;
    isExited = true;
    phase = 3;
    stdin.destroy();
    rejectAll(new Error(message));
    if (prevPhase > 0 && !isSuppressingExit) {
      options.onExit?.(exitCode, signal, prevPhase === 1);
    }
  }

  /** Parses and routes a complete inbound UTF-8 JSON-RPC 2.0 frame payload. */
  function dispatchInbound(rawPayload: string): void {
    let msg: unknown = undefined;
    try {
      msg = JSON.parse(rawPayload);
    } catch (error: unknown) {
      onProtocolError?.('Bad JSON', error);
      return;
    }
    if (!isRecord(msg) || msg.jsonrpc !== '2.0') {
      onProtocolError?.('Bad RPC');
      return;
    }
    if (isStr(msg.method)) {
      trace('receive', msg.method, rawPayload);
      const diagParams = msg.params;
      if (
        msg.method === 'textDocument/publishDiagnostics' &&
        hasArrayProp(diagParams, 'diagnostics') &&
        isValidUri(diagParams.uri)
      ) {
        try {
          options.onPublishDiagnostics?.(diagParams as unknown as LspPublishDiagnosticsParams);
        } catch (error: unknown) {
          onProtocolError?.('publishDiagnostics', error);
        }
      } else if (isRpcId(msg.id)) {
        sendFrame({
          error: { code: JSONRPC_METHOD_NOT_FOUND, message: 'No method.' },
          id: msg.id,
          jsonrpc: '2.0',
        });
      }
      return;
    }
    const entry = isRpcId(msg.id) ? takePending(msg.id) : undefined;
    if (entry !== undefined) {
      trace('receive', `#${msg.id}`, rawPayload);
      if (msg.error !== undefined) {
        entry[1](toRpcError(msg.error));
      } else {
        entry[0](msg.result);
      }
    }
  }

  stdin.on('error', () => undefined);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => flushStderr(chunk, false));
  child.stdout.on('data', (chunk: Buffer) => {
    for (const frameEvent of feedFrameChunk(decoder, chunk)) {
      if (frameEvent.kind === 'message') {
        dispatchInbound(frameEvent.payload);
      } else {
        onProtocolError?.(frameEvent.message);
        if (frameEvent.isFatalStreamDesync) {
          child.kill('SIGKILL');
          break;
        }
      }
    }
  });
  child.on('error', (spawnErr: Error) => finishExit(null, null, spawnErr.message));
  child.on('close', (exitCode, signal) => {
    flushStderr('', true);
    finishExit(
      exitCode,
      signal,
      `Exited (${exitCode})${stderrTail.length > 0 ? `: ${stderrTail.join(' | ')}` : ''}`
    );
  });

  /** Executes graceful `shutdown` -> `exit` -> `SIGKILL` + `'close'` wait once. */
  function stopSession(): Promise<void> {
    if (phase === 3) {
      return Promise.resolve();
    }
    stopPromise ??= (async () => {
      phase = 2;
      rejectAll(createRpcError(LSP_REQUEST_CANCELLED, 'Stopped'));
      await sendReq('shutdown', null, undefined, SHUTDOWN_TIMEOUT).catch(() => undefined);
      if (!isExited) {
        sendNotify('exit');
        stdin.end();
        if (!(await waitForClose(EXIT_KILL_GRACE_TIMEOUT))) {
          await forceKill();
        }
      }
      phase = 3;
    })();
    return stopPromise;
  }

  const folders = options.workspaceFolders?.length ? options.workspaceFolders : null;

  try {
    const rawInit = await sendReq(
      'initialize',
      {
        capabilities: {
          general: { positionEncodings: [options.positionEncoding ?? 'utf-16'] },
          ...(options.hasPullDiagnosticsCapability && { textDocument: { diagnostic: {} } }),
        },
        clientInfo: { name: 'corex', version: '1.0.0' },
        processId: process.pid,
        rootUri: (options.rootUri === undefined ? folders?.[0]?.uri : options.rootUri) ?? null,
        workspaceFolders: folders,
      },
      undefined,
      0
    );
    if (!isRecord(rawInit) || !isRecord(rawInit.capabilities)) {
      throw new Error('Bad init.');
    }
    phase = 1;
    sendNotify('initialized', {});
    if (traceMode !== 'off') {
      sendNotify('$/setTrace', { value: traceMode });
    }
    return {
      getState: (): LspClientState => CLIENT_STATES[phase] ?? 'stopped',
      initializeResult: rawInit as unknown as LspInitializeResult,
      isRunning: (): boolean => phase === 1 && !isExited,
      // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- LSP 3.17 wire encoding literal
      negotiatedEncoding: rawInit.capabilities.positionEncoding === 'utf-8' ? 'utf-8' : 'utf-16',
      notify: sendNotify,
      pid: child.pid,
      request: sendReq,
      setTraceMode: (value: TraceServerMode): void => {
        traceMode = value;
        sendNotify('$/setTrace', { value });
      },
      stop: stopSession,
    };
  } catch (error: unknown) {
    phase = 3;
    if (!isExited) {
      isSuppressingExit = true;
      await forceKill();
    }
    throw error;
  }
}

/**
 * Gracefully shuts down `corex lsp` (`shutdown` -> `exit` -> `stdin.end()`), force-killing after `500 ms` if needed.
 *
 * @param session   Active `LspClientSession` to terminate.
 */
export function stopLspClient(session: LspClientSession): Promise<void> {
  return session.stop();
}

// ---------------------- LSP 3.17 Helpers ----------------------

/**
 * Validates `uri` (`<= 4096` bytes) and sends a `textDocument/${subMethod}` notification, returning `true` when queued.
 *
 * @param session     Active `LspClientSession`.
 * @param subMethod   Method suffix under `textDocument/` (`'didOpen'`, `'didChange'`, `'didSave'`, `'didClose'`).
 * @param uri         Target `file://` document URI.
 * @param extra       Optional notification fields (`{ languageId, text, version }`, `{ contentChanges, textDocument }`, `{ text }`).
 */
export function notifyTextDocument(
  session: LspClientSession,
  subMethod: string,
  uri: string,
  extra?: Readonly<Record<string, unknown>>
): boolean {
  if (!isValidUri(uri)) {
    return false;
  }
  const docProp = extra?.textDocument;
  return session.notify(
    `textDocument/${subMethod}`,
    subMethod === 'didOpen' && !isRecord(docProp)
      ? { textDocument: { ...extra, uri } }
      : { ...extra, textDocument: { ...(isRecord(docProp) ? docProp : undefined), uri } }
  );
}

/**
 * Validates `uri` (`<= 4096` bytes), sends `textDocument/${subMethod}`, and narrows the response with `guard`.
 *
 * @param session     Active `LspClientSession`.
 * @param subMethod   Method suffix under `textDocument/`.
 * @param uri         Target `file://` document URI.
 * @param extra       Additional request parameters merged alongside `textDocument: { uri }`.
 * @param guard       Pure type-guard validating the response payload.
 * @param token       Optional cancellation token.
 */
export async function requestTextDocument<T>(
  session: LspClientSession,
  subMethod: string,
  uri: string,
  extra: Readonly<Record<string, unknown>>,
  guard: (value: unknown) => value is T,
  token?: RequestCancelToken
): Promise<T | null> {
  if (!isValidUri(uri)) {
    throw createRpcError(JSONRPC_INVALID_PARAMS, 'URI > 4 KiB.');
  }
  const res = await session.request(
    `textDocument/${subMethod}`,
    { ...extra, textDocument: { uri } },
    token
  );
  return guard(res) ? res : null;
}

// ----------------------- CLI Formatter ------------------------

/**
 * Formats `sourceText` via standalone `corex fmt` inside an isolated `0o700` temporary directory.
 *
 * @param binaryPath       Validated path to the `corex` binary.
 * @param sourceText       UTF-8 `.cx` buffer text to format.
 * @param isInternalCore   Whether to pass `--internal-core` to `corex fmt`.
 * @param token            Optional cancellation token wired to `AbortController`.
 */
export async function runCorexFmtCli(
  binaryPath: string,
  sourceText: string,
  isInternalCore = false,
  token?: RequestCancelToken
): Promise<string | null> {
  if (isCancelled(token) || utf8ByteLen(sourceText) > MAX_LSP_CONTENT_LENGTH) {
    return null;
  }

  const tempDir = await mkdtemp(pathJoin(tmpdir(), 'corex-fmt-'));
  let cancelSub: DisposableLike | undefined = undefined;
  try {
    const tempFile = pathJoin(tempDir, 'buffer.cx');
    await writeFile(tempFile, sourceText, { mode: 0o600 });
    if (isCancelled(token)) {
      return null;
    }

    const abortController = new AbortController();
    cancelSub = token?.onCancellationRequested(() => abortController.abort());
    const isOk = await new Promise<boolean>((resolve) => {
      try {
        execFile(
          binaryPath,
          ['fmt', '--color=never', ...(isInternalCore ? [INTERNAL_CORE_FLAG] : []), tempFile],
          {
            maxBuffer: MAX_LSP_CONTENT_LENGTH,
            signal: abortController.signal,
            timeout: FMT_CLI_TIMEOUT,
            windowsHide: true,
          },
          (execErr) => resolve(execErr === null)
        );
      } catch {
        resolve(false);
      }
    });

    if (!isOk || isCancelled(token)) {
      return null;
    }
    const tempStat = await stat(tempFile);
    return tempStat.size <= MAX_LSP_CONTENT_LENGTH ? await readFile(tempFile, 'utf8') : null;
  } finally {
    cancelSub?.dispose();
    await rm(tempDir, { force: true, maxRetries: 3, recursive: true }).catch(() => undefined);
  }
}

/**
 * Computes a minimal single `LspTextEdit` from `originalText` to `formattedText` in $O(N)$ time.
 *
 * @param originalText    Original editor buffer text (`LF` or `CRLF`).
 * @param formattedText   Canonical `corex fmt` output text (`LF`).
 */
export function computeMinimalUtf16Edit(
  originalText: string,
  formattedText: string
): LspTextEdit | null {
  if (originalText === formattedText) {
    return null;
  }

  const origLen = originalText.length;
  const fmtLen = formattedText.length;
  const minLen = Math.min(origLen, fmtLen);

  let prefixLen = 0;
  while (
    prefixLen < minLen &&
    originalText.charCodeAt(prefixLen) === formattedText.charCodeAt(prefixLen)
  ) {
    prefixLen += 1;
  }
  if (
    prefixLen > 0 &&
    (hasSplitPair(originalText, prefixLen) || hasSplitPair(formattedText, prefixLen))
  ) {
    prefixLen -= 1;
  }

  const maxSuffix = minLen - prefixLen;
  let suffixLen = 0;
  while (
    suffixLen < maxSuffix &&
    originalText.charCodeAt(origLen - 1 - suffixLen) ===
      formattedText.charCodeAt(fmtLen - 1 - suffixLen)
  ) {
    suffixLen += 1;
  }
  if (
    suffixLen > 0 &&
    (hasSplitPair(originalText, origLen - suffixLen) ||
      hasSplitPair(formattedText, fmtLen - suffixLen))
  ) {
    suffixLen -= 1;
  }

  const endOff = origLen - suffixLen;
  let line = 0;
  let lineStart = 0;
  let startPos: LspPosition | undefined = undefined;
  for (let i = 0; i < endOff; i += 1) {
    if (i === prefixLen) {
      startPos = { character: i - lineStart, line };
    }
    if (originalText.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  const end: LspPosition = { character: endOff - lineStart, line };
  return {
    newText: formattedText.slice(prefixLen, fmtLen - suffixLen),
    range: { end, start: startPos ?? end },
  };
}

/**
 * LSP & Formatter Client – Zero-dependency JSON-RPC 2.0 `stdio` client and `corex fmt` runner.
 *
 * Implements non-backtracking `Buffer`-level `Content-Length` framing, bounded pending-request
 * multiplexing, `$/cancelRequest` forwarding, `32 MiB` outbound stream backpressure enforcement,
 * graceful/forced `corex lsp` shutdown, `corex fmt` temp-file fallback, and UTF-16 diffing.
 *
 * Contains zero `vscode` runtime imports so headless `vitest` suites run directly in Node.
 */

import { execFile as cpExecFile, spawn as cpSpawn } from 'node:child_process';
import {
  assignProps,
  fsAsync,
  getHostTmpdir,
  noop,
  numMax,
  numMin,
  pathJoin,
  splitCsv,
} from '@/binary';
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

/** Local aliases binding `child_process` entry points without CJS indirect-call wrappers. */
const [execFileProc, spawnProc] = [cpExecFile, cpSpawn];

/** Shared alias binding `clearTimeout` to a mangleable identifier. */
export const clearTimer = clearTimeout;

/** Shared alias binding `setTimeout` to a mangleable identifier. */
export const setTimer = setTimeout;

/** Local alias binding `Buffer.allocUnsafe`. */
const allocUnsafeBuf = Buffer.allocUnsafe;

/** Shared UTF-8 byte-length helper bound to `Buffer.byteLength`. */
export const utf8ByteLen: (text: string) => number = Buffer.byteLength;

/** Shared Node `'utf8'` buffer encoding identifier. */
const UTF8_BUF_ENC = 'utf8';

/** Shared LSP `textDocument/` method prefix. */
export const TEXT_DOC_PREFIX = 'textDocument/';

/** Default negotiated UTF-16 position encoding literal. */
const UTF16_ENCODING = 'utf-16';

/** Negotiated UTF-8 position encoding literal per LSP 3.17. */
// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- LSP 3.17 PositionEncodingKind wire literal
const UTF8_LSP_ENC = 'utf-8';

/** Ordered client lifecycle state names indexed by numeric phase (`0..3`). */
const CLIENT_STATES = splitCsv('starting,running,stopping,stopped') as readonly LspClientState[];

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
export const LSP_SERVER_CANCELED = -32_802;

/** LSP 3.17 content modified error code (`-32801`). */
export const LSP_CONTENT_MODIFIED = -32_801;

/** LSP 3.17 client-initiated `$/cancelRequest` error code (`-32800`). */
export const LSP_REQUEST_CANCELED = -32_800;

// ----------------------------------- REGEX PATTERNS ------------------------------------

/** Matches non-empty unsigned ASCII decimal integers without backtracking. */
const ASCII_DIGITS_RX = /^\d+$/;

/** Matches `LF` or `CRLF` line terminators without backtracking. */
const LINE_SPLIT_RX = /\r?\n/;

/** Matches the blank-line separator ending an HTTP-style LSP frame header without backtracking. */
const HEADER_SEP_RX = /\r?\n\r?\n/;

/** Matches a partial frame-header separator suffix at chunk end without backtracking. */
const PARTIAL_SEP_RX = /\r?\n\r?$|\r$/;

/** Matches a trimmed `Name: Value` HTTP header line without backtracking. */
// oxlint-disable-next-line prefer-named-capture-group -- positional groups avoid unmangleable group keys under 25 KB bundle budget
const HEADER_FIELD_RX = /^([^:\s]+)\s*:\s*(.*)$/;

// -------------------------------------- INTERNALS --------------------------------------

// ------------------------ Type Guards -------------------------

/**
 * Checks whether `token` has requested cancellation.
 *
 * @param token   Optional structural cancellation token.
 */
function isCanceled(token?: RequestCancelToken): boolean {
  return Boolean(token?.isCancellationRequested);
}

/**
 * Returns `true` when `value` is a `string`.
 *
 * @param value   Untrusted value to inspect.
 */
function isStr(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Returns `true` when `value` is a non-null, non-array plain object record.
 *
 * @param value   Untrusted value to inspect.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !isArray(value);
}

/**
 * Returns `true` when `value` is a finite JSON-RPC `number` or bounded `<= 1024` char `string`.
 *
 * @param value   Untrusted `id` property.
 */
function isRpcId(value: unknown): value is JsonRpcId {
  return Number.isFinite(value) || (isStr(value) && value.length <= 1024);
}

/**
 * Creates a structured `JsonRpcRequestError` without `class` declarations.
 *
 * @param message   Human-readable error description.
 * @param code      JSON-RPC 2.0 or LSP 3.17 integer error code (`LSP_REQUEST_CANCELED` by default).
 * @param data      Optional structured error data.
 */
function createRpcError(
  message: string,
  code: number = LSP_REQUEST_CANCELED,
  data?: unknown
): JsonRpcRequestError {
  return assignProps(new Error(message), { code, data, isJsonRpcError: true as const });
}

/**
 * Normalizes an untrusted JSON-RPC `error` field into a `JsonRpcRequestError`, logging server errors.
 *
 * @param rpcErr    Untrusted response `error` value.
 * @param onError   Optional protocol error callback for codes `> LSP_REQUEST_CANCELED`.
 */
function parseRpcError(rpcErr: unknown, onError?: (summary: string) => void): JsonRpcRequestError {
  const err =
    isRecord(rpcErr) && typeof rpcErr.code === 'number' && isStr(rpcErr.message)
      ? createRpcError(rpcErr.message, rpcErr.code, rpcErr.data)
      : createRpcError('RPC', -32_603);
  if (err.code > LSP_REQUEST_CANCELED) {
    onError?.(err.message);
  }
  return err;
}

/**
 * Returns `true` when `uri` is a non-empty string within `MAX_LSP_URI_BYTES` (`4096`).
 *
 * @param uri   Untrusted document URI value.
 */
function isValidUri(uri: unknown): uri is string {
  const byteLen = isStr(uri) ? utf8ByteLen(uri) : 0;
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
 * Updates all four `FrameDecoderState` fields in place and returns `state`.
 *
 * @param state                 Target decoder state object.
 * @param rxBuffer              Backing receive buffer.
 * @param parsedContentLength   Pending body byte length (`null` between frames).
 * @param readOffset            Start index of unread bytes.
 * @param writeOffset           End index of buffered bytes.
 */
function setDecoder(
  state: FrameDecoderState,
  rxBuf: Buffer,
  parsedContentLength: number | null = null,
  readOff = 0,
  writeOff = 0
): FrameDecoderState {
  const isIdle = readOff === writeOff && parsedContentLength === null;
  return assignProps(state, {
    parsedContentLength,
    readOffset: isIdle ? 0 : readOff,
    rxBuffer: isIdle && rxBuf.length > 1_048_576 ? allocUnsafeBuf(INITIAL_RX_BUFFER_BYTES) : rxBuf,
    writeOffset: isIdle ? 0 : writeOff,
  });
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
      const match = HEADER_FIELD_RX.exec(line);
      if (!match) {
        return -1;
      }
      if ((match[1] as string).toLowerCase() === 'content-length') {
        const valText = match[2] as string;
        const parsed = ASCII_DIGITS_RX.test(valText) ? Number(valText) : -1;
        if (parsed < 0 || (found >= 0 && found !== parsed)) {
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
 * Serializes `message` into UTF-8 JSON text and a `Content-Length` (bytes) framed `Buffer`.
 *
 * @param message   JSON-RPC 2.0 object.
 */
function packJsonRpc(message: object): readonly [Buffer, string] {
  const jsonText = JSON.stringify(message);
  const bodyLength = utf8ByteLen(jsonText);
  if (bodyLength > MAX_LSP_CONTENT_LENGTH) {
    throw createRpcError('Payload > 16 MiB', -32_600);
  }
  return [Buffer.from(`Content-Length: ${bodyLength}\r\n\r\n${jsonText}`), jsonText];
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

export { isCanceled, isRecord, isStr, isValidUri };

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
  return setDecoder({} as FrameDecoderState, allocUnsafeBuf(numMax(initialCapacity, 64)));
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

  let needed = writeOff + chunk.length;
  if (needed > rxBuf.length && readOff > 0) {
    rxBuf.copyWithin(0, readOff, writeOff);
    writeOff -= readOff;
    needed -= readOff;
    readOff = 0;
  }
  if (needed > rxBuf.length) {
    const grown = allocUnsafeBuf(numMax(rxBuf.length * 2, needed));
    rxBuf.copy(grown, 0, 0, writeOff);
    rxBuf = grown;
  }
  chunk.copy(rxBuf, writeOff);
  writeOff = needed;

  const events: DecodedFrameEvent[] = [];
  while (readOff < writeOff) {
    if (bodyLen === null) {
      const headerWindow = rxBuf.toString(
        'latin1',
        readOff,
        numMin(writeOff, readOff + MAX_LSP_HEADER_BYTES + 4)
      );
      const match = HEADER_SEP_RX.exec(headerWindow);
      if (!match || match.index > MAX_LSP_HEADER_BYTES) {
        if (
          match ||
          (writeOff - readOff > MAX_LSP_HEADER_BYTES &&
            (PARTIAL_SEP_RX.exec(headerWindow)?.index ?? 9999) > MAX_LSP_HEADER_BYTES)
        ) {
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
      events.push({ kind: 'message', payload: rxBuf.toString(UTF8_BUF_ENC, readOff, bodyEnd) });
      readOff = bodyEnd;
      bodyLen = null;
    }
  }

  setDecoder(state, rxBuf, bodyLen, readOff, writeOff);
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
  const { onProtocolError, workspaceFolders } = options;
  const child = spawnProc(
    options.binaryPath,
    ['lsp', '--stdio', ...(options.isInternalCore ? [INTERNAL_CORE_FLAG] : [])],
    { cwd: options.cwd, env: options.env, windowsHide: true }
  );
  const { stdin } = child;
  const decoder = createFrameDecoderState();
  const pending = new Map<JsonRpcId, PendingEntry>();
  let phase: 0 | 1 | 2 | 3 = 0;
  let isExited = false;
  let nextReqId = 1;
  let stderrRem = '';
  let stopPromise: Promise<void> | undefined = undefined;
  let traceMode: TraceServerMode = options.traceMode ?? 'off';

  /** Removes and cleans up timer/cancellation state for `reqId`, optionally rejecting with `err`. */
  function takePending(reqId: JsonRpcId, err?: Error): PendingEntry | undefined {
    const entry = pending.get(reqId);
    if (entry) {
      pending.delete(reqId);
      clearTimer(entry[2]);
      entry[3]?.dispose();
      if (err) {
        entry[1](err);
      }
    }
    return entry;
  }

  /** Rejects all currently pending requests with `reason`. */
  function rejectAll(reason: Error): void {
    for (const [reqId] of pending) {
      takePending(reqId, reason);
    }
  }

  /** Terminates `child` unconditionally via `SIGKILL`. */
  function killChild(): boolean {
    return child.kill('SIGKILL');
  }

  /**
   * Resolves `true` if `child` emits `'close'` within `graceMs` (or kills first and waits `250 ms`).
   *
   * @param graceMs   Optional graceful wait duration (ms) before falling back to `SIGKILL`.
   */
  function waitForClose(graceMs?: number): Promise<boolean> | boolean {
    if (!graceMs) {
      killChild();
    }
    return (
      isExited ||
      new Promise<boolean>((resolve) => {
        const timer = setTimer(() => resolve(false), graceMs ?? 250);
        child.once('close', () => {
          clearTimer(timer);
          resolve(true);
        });
      })
    );
  }

  /** Emits a JSON-RPC trace event when `traceMode !== 'off'`. */
  function trace(isRecv: 0 | 1, summary: string, jsonText: string): void {
    if (traceMode !== 'off') {
      options.onTrace?.(
        isRecv ? 'receive' : 'send',
        summary,
        traceMode === 'verbose' ? jsonText : undefined
      );
    }
  }

  /** Frames and writes `message` to `stdin`, force-killing `child` if `> 32 MiB` is queued. */
  function sendFrame(message: Readonly<Record<string, unknown>>, traceLabel?: string): boolean {
    if (isExited || !stdin.writable) {
      return false;
    }
    const [frame, jsonText] = packJsonRpc({ jsonrpc: '2.0', ...message });
    if (stdin.writableLength + frame.length > 33_554_432) {
      onProtocolError?.('Queue full');
      killChild();
      return false;
    }
    if (traceLabel) {
      trace(0, traceLabel, jsonText);
    }
    stdin.write(frame);
    return true;
  }

  /** Sends a JSON-RPC 2.0 notification frame, returning `true` when queued to `stdin`. */
  function sendNotify(method: string, params?: unknown): boolean {
    try {
      return (
        (phase === 1 || (phase === 2 && method === 'exit')) && sendFrame({ method, params }, method)
      );
    } catch (error: unknown) {
      onProtocolError?.(method, error);
      return false;
    }
  }

  /** Sends a JSON-RPC 2.0 request frame with timeout and cancellation forwarding. */
  async function sendReq(
    method: string,
    params: unknown,
    token?: RequestCancelToken,
    internalTimeout?: number
  ): Promise<unknown> {
    if ((phase !== 1 && internalTimeout === undefined) || isCanceled(token)) {
      throw createRpcError('Canceled');
    }
    if (pending.size >= MAX_PENDING_REQUESTS) {
      throw createRpcError('Busy', -32_803);
    }

    const reqId = nextReqId;
    nextReqId += 1;
    if (!sendFrame({ id: reqId, method, params }, `${method} (${reqId})`)) {
      throw createRpcError('Closed');
    }

    return new Promise<unknown>((resolve, reject) => {
      /** Forwards `$/cancelRequest` for `reqId`. */
      function sendCancel(): boolean {
        return sendNotify('$/cancelRequest', { id: reqId });
      }
      pending.set(reqId, [
        resolve,
        reject,
        setTimer(
          () => {
            if (takePending(reqId, createRpcError('Timeout', -32_802))) {
              onProtocolError?.(`Timeout: ${method}`);
              sendCancel();
            }
          },
          internalTimeout || options.requestTimeoutMs || 30_000
        ),
        token?.onCancellationRequested(() => pending.has(reqId) && sendCancel()),
      ]);
    });
  }

  /** Splits incoming UTF-8 `stderr` chunks into bounded diagnostic lines. */
  function flushStderr(incomingText: string, isClosing?: boolean): void {
    const parts = (stderrRem + incomingText).split(LINE_SPLIT_RX);
    stderrRem = isClosing ? '' : (parts.pop() ?? '').slice(0, MAX_LSP_HEADER_BYTES);
    for (const rawLine of parts) {
      if (rawLine) {
        options.onStderr?.(rawLine.slice(0, MAX_LSP_HEADER_BYTES));
      }
    }
  }

  /** Finalizes child termination, rejecting in-flight requests and notifying `onExit`. */
  function finishExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    message = `Exited (${exitCode})`
  ): void {
    if (!isExited) {
      const prevPhase = phase;
      isExited = true;
      phase = 3;
      stdin.destroy();
      rejectAll(new Error(message));
      if (prevPhase > 0) {
        options.onExit?.(exitCode, signal, prevPhase === 1);
      }
    }
  }

  /** Parses and routes a complete inbound UTF-8 JSON-RPC 2.0 frame payload. */
  function dispatchInbound(rawPayload: string): void {
    let msg: unknown = undefined;
    try {
      msg = JSON.parse(rawPayload);
    } catch (error: unknown) {
      onProtocolError?.('JSON', error);
      return;
    }
    if (!isRecord(msg) || msg.jsonrpc !== '2.0') {
      onProtocolError?.('RPC');
      return;
    }
    const { error: rpcErr, id: msgId, method, params, result } = msg;
    if (isStr(method)) {
      trace(1, method, rawPayload);
      if (
        method === `${TEXT_DOC_PREFIX}publishDiagnostics` &&
        hasArrayProp(params, 'diagnostics') &&
        isValidUri(params.uri)
      ) {
        try {
          options.onPublishDiagnostics?.(params as unknown as LspPublishDiagnosticsParams);
        } catch (error: unknown) {
          onProtocolError?.(method, error);
        }
      } else if (isRpcId(msgId)) {
        sendFrame({ error: { code: -32_601, message: 'No method' }, id: msgId });
      }
      return;
    }
    const entry = isRpcId(msgId) && takePending(msgId);
    if (entry) {
      trace(1, `#${msgId}`, rawPayload);
      if (rpcErr !== undefined) {
        entry[1](parseRpcError(rpcErr, onProtocolError));
      } else {
        entry[0](result);
      }
    }
  }

  stdin.on('error', noop);
  child.stderr.setEncoding(UTF8_BUF_ENC).on('data', flushStderr);
  child.stdout.on('data', (chunk: Buffer) => {
    for (const frameEvent of feedFrameChunk(decoder, chunk)) {
      if (frameEvent.kind === 'message') {
        dispatchInbound(frameEvent.payload);
      } else {
        onProtocolError?.(frameEvent.message);
        if (frameEvent.isFatalStreamDesync) {
          killChild();
          break;
        }
      }
    }
  });
  child
    .on('error', (spawnErr: Error) => finishExit(null, null, spawnErr.message))
    .on('close', (exitCode, signal) => {
      flushStderr('', true);
      finishExit(exitCode, signal);
    });

  /** Updates `traceMode` and notifies `$/setTrace`. */
  function applyTraceMode(value: TraceServerMode): void {
    traceMode = value;
    sendNotify('$/setTrace', { value });
  }

  const folders = workspaceFolders?.[0] ? workspaceFolders : null;

  try {
    const rawInit = await sendReq(
      'initialize',
      {
        capabilities: {
          general: { positionEncodings: [options.positionEncoding ?? UTF16_ENCODING] },
        },
        processId: process.pid,
        rootUri: options.rootUri ?? folders?.[0]?.uri ?? null,
        workspaceFolders: folders,
      },
      undefined,
      15_000
    );
    if (!isRecord(rawInit) || !isRecord(rawInit.capabilities)) {
      throw new Error('Init');
    }
    phase = 1;
    sendNotify('initialized', {});
    if (traceMode !== 'off') {
      applyTraceMode(traceMode);
    }
    return {
      getState: (): LspClientState => CLIENT_STATES[phase] as LspClientState,
      initializeResult: rawInit as unknown as LspInitializeResult,
      isRunning: (): boolean => phase === 1 && !isExited,
      negotiatedEncoding:
        rawInit.capabilities.positionEncoding === UTF8_LSP_ENC ? UTF8_LSP_ENC : UTF16_ENCODING,
      notify: sendNotify,
      pid: child.pid,
      request: sendReq,
      setTraceMode: applyTraceMode,
      stop: (): Promise<void> =>
        (stopPromise ??= (async () => {
          if (phase < 3) {
            phase = 2;
            rejectAll(createRpcError('Stopped'));
            await sendReq('shutdown', null, undefined, 2000).catch(noop);
            if (!isExited) {
              sendNotify('exit');
              stdin.end();
              await ((await waitForClose(500)) || waitForClose());
            }
            phase = 3;
          }
        })()),
    };
  } catch (error: unknown) {
    if (!isExited) {
      await waitForClose();
    }
    phase = 3;
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
 * Merges `extra` with `{ textDocument: { ...docFields, uri } }` for `textDocument/*` traffic.
 *
 * @param uri         Canonical `file://` document URI.
 * @param extra       Optional outer request or notification fields.
 * @param docFields   Optional inner `textDocument` fields (`version`, `languageId`, `text`).
 */
export function withDocUri(
  uri: string,
  extra?: Readonly<Record<string, unknown>>,
  docFields?: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return { ...extra, textDocument: { ...docFields, uri } };
}

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
  const docProp = extra?.textDocument;
  return (
    isValidUri(uri) &&
    session.notify(
      TEXT_DOC_PREFIX + subMethod,
      subMethod === 'didOpen' && !isRecord(docProp)
        ? withDocUri(uri, undefined, extra)
        : withDocUri(uri, extra, isRecord(docProp) ? docProp : undefined)
    )
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
    throw createRpcError('URI > 4 KiB.', JSONRPC_INVALID_PARAMS);
  }
  const res = await session.request(TEXT_DOC_PREFIX + subMethod, withDocUri(uri, extra), token);
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
  if (isCanceled(token) || utf8ByteLen(sourceText) > MAX_LSP_CONTENT_LENGTH) {
    return null;
  }

  const tempDir = await fsAsync.mkdtemp(pathJoin(getHostTmpdir(), 'cx-fmt-'));
  const tempFile = pathJoin(tempDir, 'b.cx');
  let cancelSub: DisposableLike | undefined = undefined;
  try {
    await fsAsync.writeFile(tempFile, sourceText, { mode: 0o600 });
    const abortController = new AbortController();
    cancelSub = token?.onCancellationRequested(() => abortController.abort());
    if (
      !isCanceled(token) &&
      (await new Promise<boolean>((resolve) => {
        execFileProc(
          binaryPath,
          ['fmt', ...(isInternalCore ? [INTERNAL_CORE_FLAG] : []), tempFile],
          { signal: abortController.signal, timeout: 5000, windowsHide: true },
          (execErr) => resolve(!execErr && !isCanceled(token))
        );
      }))
    ) {
      const formatted = await fsAsync.readFile(tempFile, UTF8_BUF_ENC);
      return utf8ByteLen(formatted) <= MAX_LSP_CONTENT_LENGTH ? formatted : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    cancelSub?.dispose();
    await fsAsync.rm(tempDir, { force: true, recursive: true }).catch(noop);
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
  const minLen = numMin(origLen, fmtLen);

  /** Checks whether splitting at `(origIdx, fmtIdx)` tears a surrogate or `\r\n` pair. */
  function hasTornPair(origIdx: number, fmtIdx: number): boolean {
    return hasSplitPair(originalText, origIdx) || hasSplitPair(formattedText, fmtIdx);
  }

  let prefixLen = 0;
  while (
    prefixLen < minLen &&
    originalText.charCodeAt(prefixLen) === formattedText.charCodeAt(prefixLen)
  ) {
    prefixLen += 1;
  }
  if (prefixLen > 0 && hasTornPair(prefixLen, prefixLen)) {
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
  if (suffixLen > 0 && hasTornPair(origLen - suffixLen, fmtLen - suffixLen)) {
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

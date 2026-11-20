/**
 * JSON-RPC 2.0 Framing & UTF-16 Diff Tests – Unit verification for `src/client.ts` codecs.
 *
 * Covers `Content-Length` stream framing across 1-byte chunk splits, multi-byte UTF-8 glyphs,
 * `LF`/`CRLF` headers, `8 KiB` header and `16 MiB` payload caps, idle buffer shrinking, and
 * `computeMinimalUtf16Edit` surrogate-pair and `\r\n` boundary backoff invariants.
 *
 * Executes purely in memory with zero child processes or filesystem side effects.
 */

import { describe, expect, it } from 'vitest';
import {
  computeMinimalUtf16Edit,
  createFrameDecoderState,
  encodeJsonRpcFrame,
  feedFrameChunk,
  hasArrayProp,
  INITIAL_RX_BUFFER_BYTES,
  isJsonRpcRequestError,
  isRecord,
  isStr,
  JSONRPC_INVALID_REQUEST,
  MAX_LSP_CONTENT_LENGTH,
  MAX_LSP_HEADER_BYTES,
  utf8ByteLen,
} from '@/client';
import type { DecodedFrameEvent, LspPosition, LspTextEdit } from '@/types';

// -------------------------------------- INTERNALS --------------------------------------

/**
 * Converts a 0-based UTF-16 `LspPosition` inside `sourceText` into a UTF-16 code-unit index.
 *
 * @param sourceText   Source buffer (`LF` or `CRLF`).
 * @param position     Target 0-based `(line, character)` coordinate.
 */
function positionToUtf16Offset(sourceText: string, position: LspPosition): number {
  let currentLine = 0;
  let offset = 0;
  while (offset < sourceText.length && currentLine < position.line) {
    if (sourceText.charCodeAt(offset) === 10) {
      currentLine += 1;
    }
    offset += 1;
  }
  return offset + position.character;
}

/**
 * Applies a single `LspTextEdit` to `sourceText` using UTF-16 `(line, character)` coordinates.
 *
 * @param sourceText   Original UTF-16 text.
 * @param edit         Minimal edit returned by `computeMinimalUtf16Edit`.
 */
function applyLspTextEdit(sourceText: string, edit: LspTextEdit): string {
  return [
    sourceText.slice(0, positionToUtf16Offset(sourceText, edit.range.start)),
    edit.newText,
    sourceText.slice(positionToUtf16Offset(sourceText, edit.range.end)),
  ].join('');
}

/**
 * Feeds `wireBuffer` into a fresh decoder `stepBytes` bytes at a time and collects all events.
 *
 * @param wireBuffer   Raw framed stream bytes.
 * @param stepBytes    Chunk size per `feedFrameChunk` call.
 */
function decodeInChunks(wireBuffer: Buffer, stepBytes: number): DecodedFrameEvent[] {
  const decoder = createFrameDecoderState();
  const collected: DecodedFrameEvent[] = [];
  for (let offset = 0; offset < wireBuffer.length; offset += stepBytes) {
    const slice = wireBuffer.subarray(offset, Math.min(offset + stepBytes, wireBuffer.length));
    for (const frameEvent of feedFrameChunk(decoder, slice)) {
      collected.push(frameEvent);
    }
  }
  return collected;
}

// ---------------------------------------- MAIN -----------------------------------------

// ------------------- Type Guards & Byte Len -------------------

describe('JSON-RPC type guards and UTF-8 byte helpers', () => {
  it('narrows plain records with isRecord and rejects primitives, null, and arrays', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ id: 1, jsonrpc: '2.0' })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
    expect(isRecord('jsonrpc')).toBe(false);
    expect(isRecord(42)).toBe(false);
  });

  it('validates array-bearing properties with hasArrayProp and string values with isStr', () => {
    expect(hasArrayProp({ diagnostics: [] }, 'diagnostics')).toBe(true);
    expect(hasArrayProp({ items: ['a', 'b'] }, 'items')).toBe(true);
    expect(hasArrayProp({ items: 'not-array' }, 'items')).toBe(false);
    expect(hasArrayProp({}, 'items')).toBe(false);
    expect(hasArrayProp(null, 'items')).toBe(false);
    expect(hasArrayProp(['items'], '0')).toBe(false);
    expect(isStr('corex')).toBe(true);
    expect(isStr(123)).toBe(false);
  });

  it('measures exact UTF-8 byte lengths across ASCII, BMP Unicode, and 4-byte astral glyphs', () => {
    expect(utf8ByteLen('')).toBe(0);
    expect(utf8ByteLen('corex')).toBe(5);
    expect(utf8ByteLen('…')).toBe(3);
    expect(utf8ByteLen('▸')).toBe(3);
    expect(utf8ByteLen('𐍈')).toBe(4);
    expect('𐍈'.length).toBe(2);
  });

  it('identifies structured JsonRpcRequestError instances via isJsonRpcRequestError', () => {
    expect(isJsonRpcRequestError(new Error('plain'))).toBe(false);
    expect(isJsonRpcRequestError({ code: -32_600, isJsonRpcError: true })).toBe(false);
    expect(isJsonRpcRequestError(null)).toBe(false);

    let caughtError: unknown = undefined;
    try {
      encodeJsonRpcFrame({
        jsonrpc: '2.0',
        method: 'note',
        params: { text: 'a'.repeat(MAX_LSP_CONTENT_LENGTH + 1) },
      });
    } catch (error: unknown) {
      caughtError = error;
    }
    expect(isJsonRpcRequestError(caughtError)).toBe(true);
    if (isJsonRpcRequestError(caughtError)) {
      expect(caughtError.code).toBe(JSONRPC_INVALID_REQUEST);
      expect(caughtError.isJsonRpcError).toBe(true);
    }
  });
});

// --------------- Frame Encoding & Fragmentation ---------------

describe('Content-Length frame encoding and chunked decoding', () => {
  it('encodes and decodes a single JSON-RPC 2.0 frame and resets idle offsets to 0', () => {
    const decoder = createFrameDecoderState();
    const requestObj = { id: 1, jsonrpc: '2.0', method: 'initialize', params: { processId: 99 } };
    const events = feedFrameChunk(decoder, encodeJsonRpcFrame(requestObj));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'message', payload: JSON.stringify(requestObj) });
    expect(decoder.readOffset).toBe(0);
    expect(decoder.writeOffset).toBe(0);
    expect(decoder.parsedContentLength).toBeNull();
  });

  it('extracts multiple coalesced frames delivered inside a single Buffer chunk', () => {
    const messages = [
      { id: 1, jsonrpc: '2.0', method: 'textDocument/hover' },
      { jsonrpc: '2.0', method: 'initialized', params: {} },
      { id: 2, jsonrpc: '2.0', result: { contents: '• pure (@no_alloc)' } },
    ];
    const frames: Buffer[] = [];
    for (const msg of messages) {
      frames.push(encodeJsonRpcFrame(msg));
    }
    const events = feedFrameChunk(createFrameDecoderState(), Buffer.concat(frames));

    expect(events).toHaveLength(3);
    for (let i = 0; i < messages.length; i += 1) {
      expect(events[i]).toEqual({ kind: 'message', payload: JSON.stringify(messages[i]) });
    }
  });

  it('decodes 1-byte-at-a-time chunks across multi-byte UTF-8 glyphs (…, ▸, 𐍈) without corruption', () => {
    const unicodePayload = {
      id: 7,
      jsonrpc: '2.0',
      result: { detail: 'truncation… ▸ Gothic hwair 𐍈 and ✓ check' },
    };
    const events = decodeInChunks(encodeJsonRpcFrame(unicodePayload), 1);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'message', payload: JSON.stringify(unicodePayload) });
    if (events[0]?.kind === 'message') {
      expect(events[0].payload).not.toContain('\uFFFD');
    }
  });

  it(
    String.raw`handles 1-byte splits across LF-only (\n\n) and case-insensitive Content-Type headers`,
    () => {
      const jsonBody = JSON.stringify({ jsonrpc: '2.0', method: '$/setTrace', params: 'verbose' });
      const rawWire = Buffer.from(
        `Content-Type: application/vscode-jsonrpc; charset=utf-8\ncontent-length: ${utf8ByteLen(jsonBody)}\n\n${jsonBody}`,
        'utf8'
      );
      const events = decodeInChunks(rawWire, 1);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ kind: 'message', payload: jsonBody });
    }
  );

  it('accepts identical duplicate Content-Length headers, zero-byte bodies, and empty chunks', () => {
    const decoder = createFrameDecoderState(64);
    const body = '{"ok":true}';
    const dupHeader = Buffer.from(
      `Content-Length: ${body.length}\r\ncontent-length: ${body.length}\r\n\r\n`,
      'ascii'
    );
    expect(feedFrameChunk(decoder, dupHeader)).toEqual([]);
    expect(feedFrameChunk(decoder, Buffer.alloc(0))).toEqual([]);
    expect(decoder.parsedContentLength).toBe(body.length);

    expect(feedFrameChunk(decoder, Buffer.from(body, 'utf8'))).toEqual([
      { kind: 'message', payload: body },
    ]);

    expect(feedFrameChunk(decoder, Buffer.from('Content-Length: 0\r\n\r\n', 'ascii'))).toEqual([
      { kind: 'message', payload: '' },
    ]);
  });

  it('compacts unread tail bytes via copyWithin when small decoder buffers wrap around', () => {
    const decoder = createFrameDecoderState(96);
    const firstFrame = encodeJsonRpcFrame({ id: 1, jsonrpc: '2.0', result: 'alpha' });
    const secondFrame = encodeJsonRpcFrame({ id: 2, jsonrpc: '2.0', result: 'bravo-charlie' });

    expect(
      feedFrameChunk(
        decoder,
        Buffer.concat([firstFrame, secondFrame]).subarray(0, firstFrame.length + 18)
      )
    ).toHaveLength(1);
    expect(decoder.readOffset).toBeGreaterThan(0);

    expect(feedFrameChunk(decoder, secondFrame.subarray(18))).toEqual([
      {
        kind: 'message',
        payload: JSON.stringify({ id: 2, jsonrpc: '2.0', result: 'bravo-charlie' }),
      },
    ]);
  });
});

// ------------- Resource Caps & Malformed Headers --------------

describe('Framing resource caps, malformed headers, and idle buffer shrinking', () => {
  it('accepts an exact 8 KiB header block and rejects headers > 8 KiB with header-too-large', () => {
    const body = '{}';
    const prefix = `Content-Length: ${body.length}\r\nX-Pad: `;
    const exactPad = 'p'.repeat(MAX_LSP_HEADER_BYTES - prefix.length);
    expect(
      feedFrameChunk(
        createFrameDecoderState(),
        Buffer.from(`${prefix}${exactPad}\r\n\r\n${body}`, 'ascii')
      )
    ).toEqual([{ kind: 'message', payload: body }]);

    expect(
      feedFrameChunk(
        createFrameDecoderState(),
        Buffer.from(`${prefix}${exactPad}p\r\n\r\n${body}`, 'ascii')
      )
    ).toEqual([
      {
        isFatalStreamDesync: true,
        kind: 'error',
        message: 'header-too-large',
        reason: 'header-too-large',
      },
    ]);

    const floodDecoder = createFrameDecoderState();
    expect(feedFrameChunk(floodDecoder, Buffer.alloc(MAX_LSP_HEADER_BYTES + 1, 0x41))).toEqual([
      {
        isFatalStreamDesync: true,
        kind: 'error',
        message: 'header-too-large',
        reason: 'header-too-large',
      },
    ]);
    expect(floodDecoder.readOffset).toBe(0);
    expect(floodDecoder.writeOffset).toBe(0);
  });

  it('decodes an exact 8192-byte header split mid-CRLFCRLF across chunks while still rejecting 8193 A bytes', () => {
    const body = '{"ok":1}';
    const prefix = `Content-Length: ${body.length}\r\nX-Pad: `;
    const headerAscii = `${prefix}${'p'.repeat(MAX_LSP_HEADER_BYTES - prefix.length)}`;
    expect(headerAscii.length).toBe(MAX_LSP_HEADER_BYTES);

    const splitThreeDecoder = createFrameDecoderState();
    const firstChunk8195 = Buffer.from(`${headerAscii}\r\n\r`, 'latin1');
    expect(firstChunk8195.length).toBe(MAX_LSP_HEADER_BYTES + 3);
    expect(feedFrameChunk(splitThreeDecoder, firstChunk8195)).toEqual([]);
    expect(feedFrameChunk(splitThreeDecoder, Buffer.from(`\n${body}`, 'utf8'))).toEqual([
      { kind: 'message', payload: body },
    ]);

    const splitOneDecoder = createFrameDecoderState();
    expect(feedFrameChunk(splitOneDecoder, Buffer.from(`${headerAscii}\r`, 'latin1'))).toEqual([]);
    expect(feedFrameChunk(splitOneDecoder, Buffer.from(`\n\r\n${body}`, 'utf8'))).toEqual([
      { kind: 'message', payload: body },
    ]);

    expect(
      feedFrameChunk(createFrameDecoderState(), Buffer.alloc(MAX_LSP_HEADER_BYTES + 1, 0x41))
    ).toEqual([
      {
        isFatalStreamDesync: true,
        kind: 'error',
        message: 'header-too-large',
        reason: 'header-too-large',
      },
    ]);
  });

  it('uses latin1 header scanning so high-bit bytes (0x8D, 0x8A, 0xB1, 0xB0) are never masked to ASCII', () => {
    const validFollowUp = encodeJsonRpcFrame({ id: 11, jsonrpc: '2.0', result: 'ok' });

    const maskedDigitsHeader = Buffer.concat([
      Buffer.from('Content-Length: ', 'latin1'),
      Buffer.from([0xb1, 0xb0]),
      Buffer.from('\r\n\r\n', 'latin1'),
      validFollowUp,
    ]);
    expect(feedFrameChunk(createFrameDecoderState(), maskedDigitsHeader)).toEqual([
      {
        isFatalStreamDesync: false,
        kind: 'error',
        message: 'invalid-header',
        reason: 'invalid-header',
      },
      { kind: 'message', payload: JSON.stringify({ id: 11, jsonrpc: '2.0', result: 'ok' }) },
    ]);

    const maskedCrlfHeader = Buffer.concat([
      Buffer.from('X-Bad', 'latin1'),
      Buffer.from([0x8d, 0x8a, 0x8d, 0x8a]),
      Buffer.from('NoColon\r\nContent-Length: 2\r\n\r\n', 'latin1'),
      validFollowUp,
    ]);
    expect(feedFrameChunk(createFrameDecoderState(), maskedCrlfHeader)).toEqual([
      {
        isFatalStreamDesync: false,
        kind: 'error',
        message: 'invalid-header',
        reason: 'invalid-header',
      },
      { kind: 'message', payload: JSON.stringify({ id: 11, jsonrpc: '2.0', result: 'ok' }) },
    ]);
  });

  it('rejects Content-Length > 16 MiB on inbound decode and outbound encode', () => {
    const overCapHeader = Buffer.from(
      `Content-Length: ${MAX_LSP_CONTENT_LENGTH + 1}\r\n\r\n{}`,
      'ascii'
    );
    const decoder = createFrameDecoderState();
    expect(feedFrameChunk(decoder, overCapHeader)).toEqual([
      {
        isFatalStreamDesync: true,
        kind: 'error',
        message: 'payload-too-large',
        reason: 'payload-too-large',
      },
    ]);
    expect(decoder.readOffset).toBe(0);
    expect(decoder.writeOffset).toBe(0);

    expect(() =>
      encodeJsonRpcFrame({
        jsonrpc: '2.0',
        method: 'big',
        params: 'x'.repeat(MAX_LSP_CONTENT_LENGTH),
      })
    ).toThrow('Payload > 16 MiB');
  });

  it('reports invalid-header on negative, non-numeric, missing, or conflicting Content-Length and recovers', () => {
    const followUpAscii = encodeJsonRpcFrame({ id: 9, jsonrpc: '2.0', result: null }).toString(
      'ascii'
    );
    const badHeaders = [
      'Content-Length: -5\r\n\r\n',
      'Content-Length: 12abc\r\n\r\n',
      'Content-Type: application/vscode-jsonrpc\r\n\r\n',
      'BrokenHeaderWithoutColon\r\n\r\n',
      'Content-Length: 4\r\nContent-Length: 8\r\n\r\n',
      'Content-Length: 99999999\r\nContent-Length: 4\r\n\r\n',
      'Content-Length: 4\r\nContent-Length: 99999999\r\n\r\n',
    ];

    for (const rawBadHeader of badHeaders) {
      expect(
        feedFrameChunk(
          createFrameDecoderState(),
          Buffer.from(`${rawBadHeader}${followUpAscii}`, 'ascii')
        )
      ).toEqual([
        {
          isFatalStreamDesync: false,
          kind: 'error',
          message: 'invalid-header',
          reason: 'invalid-header',
        },
        { kind: 'message', payload: JSON.stringify({ id: 9, jsonrpc: '2.0', result: null }) },
      ]);
    }
  });

  it('shrinks rxBuffer back to 64 KiB after draining an idle > 1 MiB message spike', () => {
    const decoder = createFrameDecoderState();
    expect(decoder.rxBuffer.length).toBe(INITIAL_RX_BUFFER_BYTES);

    const largeFrame = encodeJsonRpcFrame({
      id: 42,
      jsonrpc: '2.0',
      result: { text: 'z'.repeat(1_200_000) },
    });

    expect(feedFrameChunk(decoder, largeFrame.subarray(0, -16))).toEqual([]);
    expect(decoder.rxBuffer.length).toBeGreaterThan(1_048_576);

    expect(feedFrameChunk(decoder, largeFrame.subarray(-16))).toHaveLength(1);
    expect(decoder.rxBuffer.length).toBe(INITIAL_RX_BUFFER_BYTES);
    expect(decoder.readOffset).toBe(0);
    expect(decoder.writeOffset).toBe(0);
  });
});

// ------------------ Minimal UTF-16 Text Diff ------------------

describe('computeMinimalUtf16Edit', () => {
  it('returns null when originalText and formattedText are identical', () => {
    expect(computeMinimalUtf16Edit('', '')).toBeNull();
    const canonicalCx =
      'pub fn add(left_val: i32, right_val: i32) -> i32 {\n    return left_val + right_val;\n}\n';
    expect(computeMinimalUtf16Edit(canonicalCx, canonicalCx)).toBeNull();
  });

  it('computes exact minimal edits across single-line and multi-line LF and CRLF inputs', () => {
    const singleBefore = 'let value:i32=42;';
    const singleAfter = 'let value: i32 = 42;';
    const singleEdit = computeMinimalUtf16Edit(singleBefore, singleAfter);
    expect(singleEdit).toEqual({
      newText: ' i32 = ',
      range: { end: { character: 14, line: 0 }, start: { character: 10, line: 0 } },
    });
    if (singleEdit !== null) {
      expect(applyLspTextEdit(singleBefore, singleEdit)).toBe(singleAfter);
    }

    const multiLfBefore = 'pub fn main() -> i32 {\n  let x = 1;\n  return x;\n}\n';
    const multiLfAfter = 'pub fn main() -> i32 {\n    let x = 1;\n    return x;\n}\n';
    const multiLfEdit = computeMinimalUtf16Edit(multiLfBefore, multiLfAfter);
    expect(multiLfEdit).not.toBeNull();
    if (multiLfEdit !== null) {
      expect(multiLfEdit.range.start.line).toBe(1);
      expect(applyLspTextEdit(multiLfBefore, multiLfEdit)).toBe(multiLfAfter);
    }

    const crlfBefore = 'pub fn main() -> i32 {\r\n  return 0;\r\n}\r\n';
    const lfAfter = 'pub fn main() -> i32 {\n    return 0;\n}\n';
    const crlfEdit = computeMinimalUtf16Edit(crlfBefore, lfAfter);
    expect(crlfEdit).not.toBeNull();
    if (crlfEdit !== null) {
      expect(applyLspTextEdit(crlfBefore, crlfEdit)).toBe(lfAfter);
    }

    expect(computeMinimalUtf16Edit('fn a() {}', 'fn a() {}\n')).toEqual({
      newText: '\n',
      range: { end: { character: 9, line: 0 }, start: { character: 9, line: 0 } },
    });
  });

  it('backs off prefixLen when a shared high surrogate would split an astral UTF-16 pair', () => {
    const astralB = '\uD800\uDF49';
    const beforeText = 'let glyph = "\uD800\uDF48";\n';
    const afterText = `let glyph = "${astralB}";\n`;
    const edit = computeMinimalUtf16Edit(beforeText, afterText);

    expect(edit).not.toBeNull();
    if (edit !== null) {
      expect(edit.range.start).toEqual({ character: 13, line: 0 });
      expect(edit.range.end).toEqual({ character: 15, line: 0 });
      expect(edit.newText).toBe(astralB);
      expect(applyLspTextEdit(beforeText, edit)).toBe(afterText);
    }
  });

  it('backs off suffixLen when a shared low surrogate would split an astral UTF-16 pair', () => {
    const linearASign = '\uD801\uDF48';
    const beforeText = 'let rune = "\uD800\uDF48";\n';
    const afterText = `let rune = "${linearASign}";\n`;
    const edit = computeMinimalUtf16Edit(beforeText, afterText);

    expect(edit).not.toBeNull();
    if (edit !== null) {
      expect(edit.range.start).toEqual({ character: 12, line: 0 });
      expect(edit.range.end).toEqual({ character: 14, line: 0 });
      expect(edit.newText).toBe(linearASign);
      expect(applyLspTextEdit(beforeText, edit)).toBe(afterText);
    }
  });

  it(
    String.raw`backs off prefixLen and suffixLen so \r\n CRLF pairs are never torn in half`,
    () => {
      const prefixCrlfBefore = 'fn demo()\r\n{\r\n}\r\n';
      const prefixCrOnlyAfter = 'fn demo()\r {\r\n}\r\n';
      const prefixEdit = computeMinimalUtf16Edit(prefixCrlfBefore, prefixCrOnlyAfter);

      expect(prefixEdit).not.toBeNull();
      if (prefixEdit !== null) {
        expect(prefixEdit.range.start).toEqual({ character: 9, line: 0 });
        expect(prefixEdit.newText.startsWith('\r')).toBe(true);
        expect(applyLspTextEdit(prefixCrlfBefore, prefixEdit)).toBe(prefixCrOnlyAfter);
      }

      const suffixCrlfBefore = 'fn demo() {\n}\r\n';
      const suffixLfAfter = 'fn demo() {\r\n}\n';
      const suffixEdit = computeMinimalUtf16Edit(suffixCrlfBefore, suffixLfAfter);

      expect(suffixEdit).not.toBeNull();
      if (suffixEdit !== null) {
        expect(suffixEdit.range.end).toEqual({ character: 0, line: 2 });
        expect(suffixEdit.newText.endsWith('\n')).toBe(true);
        expect(applyLspTextEdit(suffixCrlfBefore, suffixEdit)).toBe(suffixLfAfter);
      }
    }
  );
});

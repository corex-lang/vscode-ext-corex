/**
 * Headless LSP & CLI Formatter Integration Tests – Live Stage-0 verification suite.
 *
 * Spawns the live `../corex/build/stage0/corex[.exe]` binary to verify end-to-end `corex lsp`
 * protocol negotiation, push/pull diagnostics, hover, definition, semantic tokens, completion,
 * inlay hints, hygienic rename, formatting, `--internal-core`, `runCorexFmtCli`, and extension
 * host Workspace Trust / lifecycle supervision (`src/extension.ts`).
 *
 * Terminates every spawned child process and removes temporary directories in `afterEach`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtensionContext } from 'vscode';
import { resolveCorexBinary } from '@/binary';
import {
  hasArrayProp,
  isRecord,
  isStr,
  MAX_LSP_CONTENT_LENGTH,
  notifyTextDocument,
  requestTextDocument,
  runCorexFmtCli,
  startLspClient,
  stopLspClient,
} from '@/client';
import { invalidateConfigCache } from '@/config';
import { activate, deactivate } from '@/extension';
import type {
  LspClientSession,
  LspDocumentDiagnosticReport,
  LspHover,
  LspLocation,
  LspPrepareRenameResult,
  LspPublishDiagnosticsParams,
  LspSemanticTokens,
  LspTextEdit,
  LspWorkspaceEdit,
} from '@/types';
import { disposeLogger } from '@/utils/logger';
import {
  changeMockDocument,
  commands,
  createMockCancelToken,
  EndOfLine,
  getMockState,
  openMockDocument,
  Position,
  resetVscodeMock,
  setNextDialogChoice,
  setWorkspaceConfig,
  setWorkspaceFolders,
  setWorkspaceTrusted,
  Uri,
} from './__mocks__/vscode';
import type {
  MockDisposable,
  MockHover,
  MockMarkdownString,
  MockTextDocument,
  MockTextEdit,
} from './__mocks__/vscode';

// ---------------------------------------- TYPES ----------------------------------------

/** Structural shape of a registered `DocumentFormattingEditProvider` in `vscode` mock. */
interface FormattingProviderHandle {
  /** Computes formatting text edits for `document`. */
  readonly provideDocumentFormattingEdits: (
    document: MockTextDocument,
    options: { readonly insertSpaces: boolean; readonly tabSize: number },
    token: { readonly isCancellationRequested: boolean; readonly onCancellationRequested: unknown }
  ) => Promise<MockTextEdit[] | null>;
}

/** Structural shape of a registered `HoverProvider` in `vscode` mock. */
interface HoverProviderHandle {
  /** Queries hover card contents at `position`. */
  readonly provideHover: (
    document: MockTextDocument,
    position: { readonly character: number; readonly line: number },
    token: { readonly isCancellationRequested: boolean; readonly onCancellationRequested: unknown }
  ) => Promise<MockHover | null>;
}

/** Recorded JSON-RPC trace event captured via `onTrace`. */
interface CapturedTraceEntry {
  /** Traffic direction (`'send'` or `'receive'`). */
  readonly direction: 'send' | 'receive';
  /** Optional verbose JSON payload string. */
  readonly payload?: string;
  /** Concise trace header summary. */
  readonly summary: string;
}

// --------------------------------------- CONSTS ----------------------------------------

/** Extension repository root (`D:\GitHub\vscode-ext-corex`). */
const EXT_ROOT = path.resolve(import.meta.dirname, '..');

/** Sibling CoreX compiler repository root (`D:\GitHub\corex`). */
const COREX_ROOT = path.resolve(EXT_ROOT, '..', 'corex');

/** Canonical valid `.cx` module fixture exercising doc comments, contracts, calls, and locals. */
const VALID_MAIN_CX = [
  '//! Verification sample module.',
  '',
  '/// Computes the wrapping sum of two 32-bit signed integers.',
  '@no_alloc @no_panic',
  'pub fn add_pair(left_val: i32, right_val: i32) -> i32 {',
  '    return left_val +% right_val;',
  '}',
  '',
  '/// Entry point combining paired sums.',
  'pub fn main() -> i32 {',
  '    let total = add_pair(10, 21);',
  '    return add_pair(total, total);',
  '}',
  '',
].join('\n');

/** Invalid `.cx` module fixture containing a deliberate return-type mismatch (`str` vs `i32`). */
const INVALID_MAIN_CX = ['pub fn main() -> i32 {', '    return "type_mismatch";', '}', ''].join(
  '\n'
);

// -------------------------------------- INTERNALS --------------------------------------

/** Active `LspClientSession` handles spawned by the current test, drained in `afterEach`. */
const spawnedClients: LspClientSession[] = [];

/** Temporary directories created by the current test, removed in `afterEach`. */
const createdTempDirs: string[] = [];

/** Subscriptions pushed onto a mock `ExtensionContext` during `activate()`. */
const contextSubscriptions: MockDisposable[] = [];

/** Resolves the live Stage-0 `corex` binary via Tier 3 sibling discovery. */
function getLiveBinaryPath(): string {
  const res = resolveCorexBinary('', {
    env: {},
    homeDir: path.resolve('/non-existent-home'),
    workspaceDirs: [EXT_ROOT],
  });
  expect(res.isFound).toBe(true);
  if (!res.isFound) {
    throw new Error('Stage-0 corex binary was not found under ../corex/build/stage0/.');
  }
  return res.binaryPath;
}

/** Creates an isolated temporary workspace directory registered for `afterEach` cleanup. */
async function makeTempWorkspace(): Promise<string> {
  const dirPath = await mkdtemp(path.join(tmpdir(), 'corex-lsp-test-'));
  createdTempDirs.push(dirPath);
  await writeFile(
    path.join(dirPath, 'corex.toml'),
    ['[package]', 'name = "lsp-verify"', 'version = "0.1.0"', 'edition = "2026"', ''].join('\n'),
    'utf8'
  );
  await mkdir(path.join(dirPath, 'src'), { recursive: true });
  return dirPath;
}

/** Creates a minimal `ExtensionContext` double backed by `contextSubscriptions`. */
function createMockExtensionContext(): ExtensionContext {
  return { subscriptions: contextSubscriptions } as unknown as ExtensionContext;
}

/**
 * Extracts plain or `MarkdownString` text from a mock status-bar tooltip.
 *
 * @param rawTooltip   Status-bar `tooltip` value (`string | MockMarkdownString | undefined`).
 */
function readTooltipValue(rawTooltip: string | MockMarkdownString | undefined): string {
  if (rawTooltip === undefined) {
    return '';
  }
  return typeof rawTooltip === 'string' ? rawTooltip : rawTooltip.value;
}

/**
 * Pauses for `delayMs` milliseconds when polling asynchronous notifications or status transitions.
 *
 * @param delayMs   Sleep duration in milliseconds.
 */
function sleepMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Polls `predicate` every `20 ms` up to `timeoutMs`, throwing if not satisfied in time.
 *
 * @param predicate   Condition callback returning `true` when ready.
 * @param label       Diagnostic label included in timeout errors.
 * @param timeoutMs   Maximum wait ceiling in milliseconds (`5000` by default).
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleepMs(20);
  }
  throw new Error(`Timed out waiting for condition: ${label}`);
}

/**
 * Type guard checking `LspDocumentDiagnosticReport` payloads.
 *
 * @param value   Untrusted JSON-RPC response result.
 */
function isDiagnosticReport(value: unknown): value is LspDocumentDiagnosticReport {
  return isRecord(value) && (value.kind === 'full' || value.kind === 'unchanged');
}

/**
 * Type guard checking `LspHover` payloads.
 *
 * @param value   Untrusted JSON-RPC response result.
 */
function isHoverPayload(value: unknown): value is LspHover {
  return isRecord(value) && (isStr(value.contents) || isRecord(value.contents));
}

/**
 * Type guard checking `LspSemanticTokens` payloads.
 *
 * @param value   Untrusted JSON-RPC response result.
 */
function isSemanticTokensPayload(value: unknown): value is LspSemanticTokens {
  return hasArrayProp(value, 'data');
}

/**
 * Type guard checking `LspPrepareRenameResult` payloads.
 *
 * @param value   Untrusted JSON-RPC response result.
 */
function isPrepareRenamePayload(value: unknown): value is LspPrepareRenameResult {
  return isRecord(value) && isStr(value.placeholder) && isRecord(value.range);
}

/**
 * Type guard checking `LspWorkspaceEdit` payloads.
 *
 * @param value   Untrusted JSON-RPC response result.
 */
function isWorkspaceEditPayload(value: unknown): value is LspWorkspaceEdit {
  return isRecord(value) && isRecord(value.changes);
}

/**
 * Type guard checking `LspTextEdit[]` array payloads.
 *
 * @param value   Untrusted JSON-RPC response result.
 */
function isTextEditArray(value: unknown): value is readonly LspTextEdit[] {
  return Array.isArray(value);
}

/**
 * Returns `true` when `batches` contains a zero-error `publishDiagnostics` frame for `version`.
 *
 * @param batches   Recorded push diagnostic notifications.
 * @param version   Expected document version (`undefined` accepted if server omits `version`).
 */
function hasCleanDiagnosticsAtVersion(
  batches: readonly LspPublishDiagnosticsParams[],
  version: number
): boolean {
  for (const batch of batches) {
    if (
      (batch.version === undefined || batch.version === version) &&
      batch.diagnostics.length === 0
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------- MAIN -----------------------------------------

afterEach(async () => {
  await deactivate();
  for (const sub of contextSubscriptions) {
    sub.dispose();
  }
  contextSubscriptions.length = 0;

  for (const client of spawnedClients) {
    await stopLspClient(client).catch(() => undefined);
  }
  spawnedClients.length = 0;

  for (const dirPath of createdTempDirs) {
    await rm(dirPath, { force: true, recursive: true }).catch(() => undefined);
  }
  createdTempDirs.length = 0;

  invalidateConfigCache();
  disposeLogger();
  resetVscodeMock();
});

// ------- 1. Standard Workspace LSP Lifecycle & Queries --------

describe('Headless corex lsp lifecycle, diagnostics, navigation, tokens, rename, and formatting', () => {
  it('negotiates UTF-16 initialize capabilities, streams push/pull diagnostics, traces JSON-RPC, and stops cleanly', async () => {
    const workspaceDir = await makeTempWorkspace();
    const mainFilePath = path.join(workspaceDir, 'src', 'main.cx');
    await writeFile(mainFilePath, VALID_MAIN_CX, 'utf8');

    const mainUri = Uri.file(mainFilePath).toString();
    const pushedDiagnostics: LspPublishDiagnosticsParams[] = [];
    const traceEvents: CapturedTraceEntry[] = [];

    const session = await startLspClient({
      binaryPath: getLiveBinaryPath(),
      cwd: workspaceDir,
      onPublishDiagnostics: (params) => {
        if (Uri.parse(params.uri).toString() === mainUri) {
          pushedDiagnostics.push(params);
        }
      },
      onTrace: (direction, summary, payload) => {
        traceEvents.push({ direction, payload, summary });
      },
      workspaceFolders: [{ name: 'lsp-verify', uri: Uri.file(workspaceDir).toString() }],
    });
    spawnedClients.push(session);

    expect(session.getState()).toBe('running');
    expect(session.isRunning()).toBe(true);
    expect(session.negotiatedEncoding).toBe('utf-16');
    expect(session.pid).toBeTypeOf('number');

    const { capabilities } = session.initializeResult;
    expect(Boolean(capabilities.hoverProvider && capabilities.definitionProvider)).toBe(true);
    expect(Boolean(capabilities.inlayHintProvider && capabilities.renameProvider)).toBe(true);
    expect(
      Boolean(
        capabilities.documentFormattingProvider && capabilities.documentRangeFormattingProvider
      )
    ).toBe(true);
    expect(capabilities.completionProvider).toBeDefined();
    expect(capabilities.diagnosticProvider).toBeDefined();
    expect(capabilities.semanticTokensProvider?.legend).toEqual({
      tokenModifiers: [
        'declaration',
        'definition',
        'readonly',
        'static',
        'deprecated',
        'abstract',
        'async',
        'modification',
        'documentation',
        'defaultLibrary',
        'mutable',
        'consumedMove',
        'unsafe',
        'attribute',
        'linearResource',
      ],
      tokenTypes: [
        'namespace',
        'type',
        'struct',
        'enum',
        'interface',
        'typeParameter',
        'parameter',
        'variable',
        'property',
        'enumMember',
        'function',
        'method',
        'macro',
        'keyword',
        'modifier',
        'comment',
        'string',
        'number',
        'operator',
        'decorator',
      ],
    });

    notifyTextDocument(session, 'didOpen', mainUri, {
      languageId: 'corex',
      text: VALID_MAIN_CX,
      version: 1,
    });
    await waitUntil(() => pushedDiagnostics.length >= 1, 'initial valid didOpen diagnostics');
    expect(pushedDiagnostics.at(-1)?.diagnostics).toHaveLength(0);

    pushedDiagnostics.length = 0;
    notifyTextDocument(session, 'didChange', mainUri, {
      contentChanges: [{ text: INVALID_MAIN_CX }],
      textDocument: { version: 2 },
    });
    await waitUntil(
      () => (pushedDiagnostics.at(-1)?.diagnostics.length ?? 0) > 0,
      'type-error diagnostics after didChange v2'
    );
    expect(pushedDiagnostics.at(-1)?.diagnostics[0]?.severity).toBe(1);

    pushedDiagnostics.length = 0;
    notifyTextDocument(session, 'didChange', mainUri, {
      contentChanges: [{ text: VALID_MAIN_CX }],
      textDocument: { version: 3 },
    });
    await waitUntil(
      () => hasCleanDiagnosticsAtVersion(pushedDiagnostics, 3),
      'cleared diagnostics after didChange v3'
    );

    session.setTraceMode('verbose');
    const firstPull = await requestTextDocument(
      session,
      'diagnostic',
      mainUri,
      {},
      isDiagnosticReport
    );
    expect(firstPull?.kind).toBe('full');
    if (firstPull?.kind === 'full') {
      expect(firstPull.items).toHaveLength(0);
      expect(firstPull.resultId).toBeTypeOf('string');

      const secondPull = await requestTextDocument(
        session,
        'diagnostic',
        mainUri,
        { previousResultId: firstPull.resultId },
        isDiagnosticReport
      );
      expect(secondPull).toEqual({ kind: 'unchanged', resultId: firstPull.resultId });
    }

    let hasVerboseSend = false;
    let hasVerboseReceive = false;
    for (const traceItem of traceEvents) {
      if (traceItem.direction === 'send' && isStr(traceItem.payload)) {
        hasVerboseSend = true;
      }
      if (traceItem.direction === 'receive' && isStr(traceItem.payload)) {
        hasVerboseReceive = true;
      }
    }
    expect(hasVerboseSend).toBe(true);
    expect(hasVerboseReceive).toBe(true);

    await stopLspClient(session);
    expect(session.getState()).toBe('stopped');
    expect(session.isRunning()).toBe(false);
  });

  it('serves hover, go-to-definition, full & delta semantic tokens, completion, and inlay hints', async () => {
    const workspaceDir = await makeTempWorkspace();
    const mainFilePath = path.join(workspaceDir, 'src', 'main.cx');
    await writeFile(mainFilePath, VALID_MAIN_CX, 'utf8');

    const mainUri = Uri.file(mainFilePath).toString();
    const session = await startLspClient({
      binaryPath: getLiveBinaryPath(),
      cwd: workspaceDir,
      workspaceFolders: [{ name: 'lsp-verify', uri: Uri.file(workspaceDir).toString() }],
    });
    spawnedClients.push(session);

    notifyTextDocument(session, 'didOpen', mainUri, {
      languageId: 'corex',
      text: VALID_MAIN_CX,
      version: 1,
    });

    const hoverResult = await requestTextDocument(
      session,
      'hover',
      mainUri,
      { position: { character: 18, line: 10 } },
      isHoverPayload
    );
    expect(hoverResult).not.toBeNull();
    expect(
      isStr(hoverResult?.contents) ? hoverResult.contents : (hoverResult?.contents.value ?? '')
    ).toContain('add_pair');

    const rawDef = await session.request('textDocument/definition', {
      position: { character: 18, line: 10 },
      textDocument: { uri: mainUri },
    });
    const defLoc = (Array.isArray(rawDef) ? rawDef[0] : rawDef) as LspLocation | undefined;
    expect(defLoc).toBeDefined();
    if (defLoc !== undefined) {
      expect(Uri.parse(defLoc.uri).toString()).toBe(mainUri);
      expect(defLoc.range.start.line).toBe(4);
    }

    const fullTokens = await requestTextDocument(
      session,
      'semanticTokens/full',
      mainUri,
      {},
      isSemanticTokensPayload
    );
    expect((fullTokens?.data.length ?? 0) > 0).toBe(true);
    expect((fullTokens?.data.length ?? 0) % 5).toBe(0);
    expect(fullTokens?.resultId).toBeTypeOf('string');

    const deltaTokens = await session.request('textDocument/semanticTokens/full/delta', {
      previousResultId: fullTokens?.resultId,
      textDocument: { uri: mainUri },
    });
    expect(hasArrayProp(deltaTokens, 'edits')).toBe(true);

    const rawCompletion = await session.request('textDocument/completion', {
      position: { character: 14, line: 11 },
      textDocument: { uri: mainUri },
    });
    const completionItems = hasArrayProp(rawCompletion, 'items')
      ? rawCompletion.items
      : rawCompletion;
    expect(Array.isArray(completionItems)).toBe(true);
    let hasAddPairCandidate = false;
    if (Array.isArray(completionItems)) {
      for (const entry of completionItems) {
        if (isRecord(entry) && entry.label === 'add_pair') {
          hasAddPairCandidate = true;
          break;
        }
      }
    }
    expect(hasAddPairCandidate).toBe(true);

    const rawHints = await session.request('textDocument/inlayHint', {
      range: { end: { character: 0, line: 13 }, start: { character: 0, line: 0 } },
      textDocument: { uri: mainUri },
    });
    expect(Array.isArray(rawHints) && rawHints.length > 0).toBe(true);
  });

  it('executes prepareRename, hygienic workspace rename, rangeFormatting, and whole-document formatting', async () => {
    const workspaceDir = await makeTempWorkspace();
    const mainFilePath = path.join(workspaceDir, 'src', 'main.cx');
    await writeFile(mainFilePath, VALID_MAIN_CX, 'utf8');

    const mainUri = Uri.file(mainFilePath).toString();
    const session = await startLspClient({
      binaryPath: getLiveBinaryPath(),
      cwd: workspaceDir,
      workspaceFolders: [{ name: 'lsp-verify', uri: Uri.file(workspaceDir).toString() }],
    });
    spawnedClients.push(session);

    notifyTextDocument(session, 'didOpen', mainUri, {
      languageId: 'corex',
      text: VALID_MAIN_CX,
      version: 1,
    });

    const prepRename = await requestTextDocument(
      session,
      'prepareRename',
      mainUri,
      { position: { character: 9, line: 10 } },
      isPrepareRenamePayload
    );
    expect(prepRename?.placeholder).toBe('total');

    const renameEdit = await requestTextDocument(
      session,
      'rename',
      mainUri,
      { newName: 'computed_sum', position: { character: 9, line: 10 } },
      isWorkspaceEditPayload
    );
    const changedFiles = Object.values(renameEdit?.changes ?? {});
    expect(changedFiles).toHaveLength(1);
    expect(changedFiles[0]).toHaveLength(3);

    const messyUri = Uri.file(path.join(workspaceDir, 'src', 'messy.cx')).toString();
    notifyTextDocument(session, 'didOpen', messyUri, {
      languageId: 'corex',
      text: 'pub fn messy(a:i32,b:i32)->i32{\nreturn a+b;\n}\n',
      version: 1,
    });

    const rangeEdits = await requestTextDocument(
      session,
      'rangeFormatting',
      messyUri,
      {
        options: { insertSpaces: true, tabSize: 4 },
        range: { end: { character: 0, line: 3 }, start: { character: 0, line: 0 } },
      },
      isTextEditArray
    );
    expect((rangeEdits?.length ?? 0) > 0).toBe(true);

    const fullFormatEdits = await requestTextDocument(
      session,
      'formatting',
      messyUri,
      { options: { insertSpaces: true, tabSize: 4 } },
      isTextEditArray
    );
    expect((fullFormatEdits?.length ?? 0) > 0).toBe(true);
  });
});

// --------- 2. --internal-core Mode on Live core/*.cx ----------

describe('Headless corex lsp --internal-core mode on ../corex/core/*.cx', () => {
  it('analyzes real core/atomic.cx and core/root.cx with zero @intrinsic gate errors and non-empty semantic tokens', async () => {
    const atomicPath = path.resolve(COREX_ROOT, 'core', 'atomic.cx');
    const rootPath = path.resolve(COREX_ROOT, 'core', 'root.cx');
    const [atomicText, rootText] = await Promise.all([
      readFile(atomicPath, 'utf8'),
      readFile(rootPath, 'utf8'),
    ]);

    const atomicUri = Uri.file(atomicPath).toString();
    const rootUri = Uri.file(rootPath).toString();

    const session = await startLspClient({
      binaryPath: getLiveBinaryPath(),
      cwd: COREX_ROOT,
      isInternalCore: true,
      workspaceFolders: [{ name: 'corex', uri: Uri.file(COREX_ROOT).toString() }],
    });
    spawnedClients.push(session);

    notifyTextDocument(session, 'didOpen', rootUri, {
      languageId: 'corex',
      text: rootText,
      version: 1,
    });
    notifyTextDocument(session, 'didOpen', atomicUri, {
      languageId: 'corex',
      text: atomicText,
      version: 1,
    });

    const atomicDiag = await requestTextDocument(
      session,
      'diagnostic',
      atomicUri,
      {},
      isDiagnosticReport
    );
    expect(atomicDiag?.kind).toBe('full');
    if (atomicDiag?.kind === 'full') {
      expect(atomicDiag.items).toHaveLength(0);
    }

    const rootDiag = await requestTextDocument(
      session,
      'diagnostic',
      rootUri,
      {},
      isDiagnosticReport
    );
    expect(rootDiag?.kind).toBe('full');
    if (rootDiag?.kind === 'full') {
      expect(rootDiag.items).toHaveLength(0);
    }

    const atomicTokens = await requestTextDocument(
      session,
      'semanticTokens/full',
      atomicUri,
      {},
      isSemanticTokensPayload
    );
    expect((atomicTokens?.data.length ?? 0) > 50).toBe(true);
    expect((atomicTokens?.data.length ?? 0) % 5).toBe(0);
  });
});

// ------------ 3. Standalone CLI Formatter Fallback ------------

describe('Standalone CLI formatter (runCorexFmtCli)', () => {
  it('formats unformatted LF and CRLF .cx buffers into canonical 4-space LF output', async () => {
    const binaryPath = getLiveBinaryPath();
    const expectedCanonical = [
      'pub fn calc(left_val: i32, right_val: i32) -> i32 {',
      '    return left_val + right_val;',
      '}',
      '',
    ].join('\n');

    expect(
      await runCorexFmtCli(
        binaryPath,
        'pub fn calc(left_val:i32,right_val:i32)->i32{\nreturn left_val+right_val;\n}\n'
      )
    ).toBe(expectedCanonical);

    const formattedFromCrlf = await runCorexFmtCli(
      binaryPath,
      'pub fn calc(left_val:i32,right_val:i32)->i32{\r\n  return left_val+right_val;\r\n}\r\n'
    );
    expect(formattedFromCrlf).toBe(expectedCanonical);
    expect(formattedFromCrlf?.includes('\r')).toBe(false);
  });

  it('returns null cleanly on syntax-error .cx buffers and pre-canceled tokens', async () => {
    const binaryPath = getLiveBinaryPath();

    expect(
      await runCorexFmtCli(
        binaryPath,
        'pub fn valid() {}\n',
        false,
        createMockCancelToken(true).token
      )
    ).toBeNull();

    expect(await runCorexFmtCli(binaryPath, 'pub fn broken( -> {{{{\n')).toBeNull();
  });
});

// --------- 4. Extension Host Lifecycle & Trust Gating ---------

describe('Extension host lifecycle (src/extension.ts via vscode mock)', () => {
  it('spawns zero processes and displays warning status in untrusted workspaces', async () => {
    setWorkspaceTrusted(false);
    setWorkspaceFolders([EXT_ROOT]);

    activate(createMockExtensionContext());
    await sleepMs(60);

    const mockState = getMockState();
    expect(mockState.providers.hover).toHaveLength(0);
    expect(mockState.providers.documentFormatting).toHaveLength(0);
    expect(mockState.statusBarItems[0]?.text).toBe('$(warning) CoreX');
    expect(mockState.statusBarItems[0]?.command).toBe('corex.showStatusMenu');
    expect(readTooltipValue(mockState.statusBarItems[0]?.tooltip)).toContain(
      '**CoreX** – Untrusted.'
    );
    expect(readTooltipValue(mockState.statusBarItems[0]?.tooltip)).toContain(
      '**Language Server (`corex lsp`):** Untrusted'
    );

    await commands.executeCommand('corex.restartServer');
    await sleepMs(20);
    expect(mockState.warningMessages[0]?.message).toBe('Grant Workspace Trust to run CoreX.');
  });

  it('formats CRLF documents via CLI fallback with LF normalization when corex.lsp.enable is false', async () => {
    setWorkspaceTrusted(true);
    setWorkspaceFolders([EXT_ROOT]);
    setWorkspaceConfig({ 'format.enable': true, 'lsp.enable': false });

    activate(createMockExtensionContext());
    await waitUntil(
      () => getMockState().providers.documentFormatting.length === 1,
      'CLI formatting provider registration'
    );

    const mockState = getMockState();
    expect(mockState.providers.hover).toHaveLength(0);
    expect(mockState.providers.documentRangeFormatting).toHaveLength(0);
    expect(readTooltipValue(mockState.statusBarItems[0]?.tooltip)).toContain(
      '**CoreX** – CLI fmt.'
    );
    expect(readTooltipValue(mockState.statusBarItems[0]?.tooltip)).toContain('Ready (CLI)');

    const crlfDoc = openMockDocument({
      fsPath: path.join(EXT_ROOT, 'sample_cli.cx'),
      text: 'pub fn cli_only(val:i32)->i32{\r\nreturn val;\r\n}\r\n',
    });
    const edits = await (
      mockState.providers.documentFormatting[0] as FormattingProviderHandle
    ).provideDocumentFormattingEdits(
      crlfDoc,
      { insertSpaces: true, tabSize: 4 },
      createMockCancelToken().token
    );

    expect(edits).not.toBeNull();
    expect((edits?.length ?? 0) >= 2).toBe(true);
    expect(edits?.at(-1)?.eol).toBe(EndOfLine.LF);
  });

  it('activates full LSP providers in a trusted workspace, serves hover, and disposes cleanly on deactivate', async () => {
    const workspaceDir = await makeTempWorkspace();
    const docPath = path.join(workspaceDir, 'src', 'main.cx');
    await writeFile(docPath, VALID_MAIN_CX, 'utf8');

    setWorkspaceTrusted(true);
    setWorkspaceFolders([workspaceDir]);
    setWorkspaceConfig({ executablePath: getLiveBinaryPath(), 'lsp.enable': true });

    const openedDoc = openMockDocument({ fsPath: docPath, text: VALID_MAIN_CX });

    activate(createMockExtensionContext());
    await waitUntil(
      () => getMockState().statusBarItems[0]?.text === '$(check) CoreX',
      'LSP ready status bar state'
    );

    const mockState = getMockState();
    expect(mockState.commands.has('corex.restartServer')).toBe(true);
    expect(mockState.commands.has('corex.showOutputChannel')).toBe(true);
    expect(mockState.commands.has('corex.showStatusMenu')).toBe(true);
    expect(mockState.commands.has('corex.stopServer')).toBe(true);
    expect(mockState.commands.has('corex.toggleInlayHints')).toBe(true);
    expect(readTooltipValue(mockState.statusBarItems[0]?.tooltip)).toContain(
      'Language Server (`corex lsp`):'
    );
    expect(readTooltipValue(mockState.statusBarItems[0]?.tooltip)).toContain(
      'Formatter (`corex fmt`):'
    );
    expect(mockState.providers.hover).toHaveLength(1);
    expect(mockState.providers.definition).toHaveLength(1);
    expect(mockState.providers.completion).toHaveLength(1);
    expect(mockState.providers.inlayHints).toHaveLength(1);
    expect(mockState.providers.documentSemanticTokens).toHaveLength(1);
    expect(mockState.providers.rename).toHaveLength(1);
    expect(mockState.providers.codeActions).toHaveLength(1);
    expect(mockState.providers.documentFormatting).toHaveLength(1);
    expect(mockState.providers.documentRangeFormatting).toHaveLength(1);

    expect(
      await (mockState.providers.hover[0] as HoverProviderHandle).provideHover(
        openedDoc,
        new Position(10, 18),
        createMockCancelToken().token
      )
    ).not.toBeNull();

    const syntaxErrCrlfPath = path.join(workspaceDir, 'src', 'broken_crlf.cx');
    const syntaxErrCrlfText = 'pub fn broken( -> {{{\r\n';
    await writeFile(syntaxErrCrlfPath, syntaxErrCrlfText, 'utf8');
    const syntaxErrCrlfDoc = openMockDocument({
      fsPath: syntaxErrCrlfPath,
      text: syntaxErrCrlfText,
    });
    expect(
      await (
        mockState.providers.documentFormatting[0] as FormattingProviderHandle
      ).provideDocumentFormattingEdits(
        syntaxErrCrlfDoc,
        { insertSpaces: true, tabSize: 4 },
        createMockCancelToken().token
      )
    ).toEqual([]);

    await commands.executeCommand('corex.showOutputChannel');
    expect(mockState.outputChannels[0]?.isShown).toBe(true);

    // Exercise status-bar QuickPick menu: Stop Language Server -> Start Language Server -> Toggle Inlay Hints:
    setNextDialogChoice('Stop Language Server');
    await commands.executeCommand('corex.showStatusMenu');
    expect(mockState.quickPicks.length).toBeGreaterThanOrEqual(1);
    expect(mockState.statusBarItems[0]?.text).toBe('$(circle-slash) CoreX');
    expect(readTooltipValue(mockState.statusBarItems[0]?.tooltip)).toContain(
      '**CoreX** – Stopped.'
    );

    setNextDialogChoice('Start Language Server');
    await commands.executeCommand('corex.showStatusMenu');
    await waitUntil(
      () => getMockState().statusBarItems[0]?.text === '$(check) CoreX',
      'LSP restarted from status menu'
    );

    await commands.executeCommand('corex.toggleInlayHints');
    expect(readTooltipValue(mockState.statusBarItems[0]?.tooltip)).toContain('Inlay Hints: On');

    const [activeStatusBar] = mockState.statusBarItems;
    const [activeCollection] = mockState.collections;

    await deactivate();

    expect(activeStatusBar?.isDisposed).toBe(true);
    expect(activeCollection?.isDisposed).toBe(true);
    expect(mockState.providers.hover).toHaveLength(0);
    expect(mockState.providers.documentFormatting).toHaveLength(0);
  }, 20_000);

  it('evicts VFS tracking on oversized > 16 MiB didChange and re-synchronizes via didOpen on next small edit', async () => {
    const binaryPath = getLiveBinaryPath();
    const workspaceDir = await makeTempWorkspace();
    const docPath = path.join(workspaceDir, 'src', 'main.cx');
    await writeFile(docPath, INVALID_MAIN_CX, 'utf8');

    const directSession = await startLspClient({
      binaryPath,
      cwd: workspaceDir,
      workspaceFolders: [{ name: 'lsp-verify', uri: Uri.file(workspaceDir).toString() }],
    });
    spawnedClients.push(directSession);
    const directUri = Uri.file(docPath).toString();
    expect(
      notifyTextDocument(directSession, 'didOpen', directUri, {
        languageId: 'corex',
        text: VALID_MAIN_CX,
        version: 1,
      })
    ).toBe(true);
    const oversizedBuffer = 'a'.repeat(MAX_LSP_CONTENT_LENGTH + 128);
    expect(
      notifyTextDocument(directSession, 'didChange', directUri, {
        contentChanges: [{ text: oversizedBuffer }],
        textDocument: { version: 2 },
      })
    ).toBe(false);
    await stopLspClient(directSession);

    setWorkspaceTrusted(true);
    setWorkspaceFolders([workspaceDir]);
    setWorkspaceConfig({ executablePath: binaryPath, 'lsp.enable': true });

    const openedDoc = openMockDocument({ fsPath: docPath, text: INVALID_MAIN_CX });
    activate(createMockExtensionContext());

    await waitUntil(
      () => (getMockState().collections[0]?.get(openedDoc.uri)?.length ?? 0) > 0,
      'initial type-mismatch diagnostics in extension host'
    );

    changeMockDocument(openedDoc, oversizedBuffer);
    expect(getMockState().collections[0]?.get(openedDoc.uri)).toBeUndefined();

    changeMockDocument(openedDoc, INVALID_MAIN_CX);
    await waitUntil(
      () => (getMockState().collections[0]?.get(openedDoc.uri)?.length ?? 0) > 0,
      're-synchronized didOpen diagnostics after oversized didChange eviction'
    );

    changeMockDocument(openedDoc, VALID_MAIN_CX);
    await waitUntil(
      () => (getMockState().collections[0]?.get(openedDoc.uri)?.length ?? -1) === 0,
      'clean diagnostics after recovering to valid code'
    );
  }, 20_000);

  it('delivers FileSystemWatcher events when /build/ is an ancestor above workspace root while ignoring <workspace>/build/*', async () => {
    const outerTempDir = await mkdtemp(path.join(tmpdir(), 'corex-parent-'));
    createdTempDirs.push(outerTempDir);
    const nestedWorkspaceDir = path.join(outerTempDir, 'build', 'nested-app');
    await mkdir(path.join(nestedWorkspaceDir, 'src'), { recursive: true });
    await writeFile(
      path.join(nestedWorkspaceDir, 'corex.toml'),
      ['[package]', 'name = "nested-app"', 'version = "0.1.0"', 'edition = "2026"', ''].join('\n'),
      'utf8'
    );
    await writeFile(path.join(nestedWorkspaceDir, 'src', 'main.cx'), VALID_MAIN_CX, 'utf8');

    setWorkspaceTrusted(true);
    setWorkspaceFolders([nestedWorkspaceDir]);
    setWorkspaceConfig({
      executablePath: getLiveBinaryPath(),
      'lsp.enable': true,
      'trace.server': 'verbose',
    });

    activate(createMockExtensionContext());
    await waitUntil(
      () => getMockState().statusBarItems[0]?.text === '$(check) CoreX',
      'nested /build/ workspace LSP ready'
    );

    const [watcher] = getMockState().watchers;
    expect(watcher).toBeDefined();
    const ignoredBuildUri = Uri.file(path.join(nestedWorkspaceDir, 'build', 'generated.cx'));
    const watchedSrcUri = Uri.file(path.join(nestedWorkspaceDir, 'src', 'watched_mod.cx'));

    watcher?.fireChange(ignoredBuildUri);
    watcher?.fireCreate(watchedSrcUri);

    await waitUntil(() => {
      const lines = getMockState().outputChannels[0]?.lines ?? [];
      for (const line of lines) {
        if (line.includes('workspace/didChangeWatchedFiles')) {
          return true;
        }
      }
      return false;
    }, 'debounced workspace/didChangeWatchedFiles trace');

    const allLogs = (getMockState().outputChannels[0]?.lines ?? []).join('\n');
    expect(allLogs).toContain(watchedSrcUri.toString());
    expect(allLogs).not.toContain(ignoredBuildUri.toString());
  });
});

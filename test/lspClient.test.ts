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
  isJsonRpcRequestError,
  isRecord,
  isStr,
  LSP_SERVER_CANCELED,
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
  LspDiagnostic,
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
  DiagnosticSeverity,
  DiagnosticTag,
  EndOfLine,
  getMockState,
  openMockDocument,
  openMockTextEditor,
  Position,
  Range,
  resetVscodeMock,
  setActiveColorThemeKind,
  setMockEditorVisibleRanges,
  setNextDialogChoice,
  setWorkspaceConfig,
  setWorkspaceFolders,
  setWorkspaceTrusted,
  Uri,
} from './__mocks__/vscode';
import type {
  MockCodeAction,
  MockDiagnostic,
  MockDisposable,
  MockHover,
  MockMarkdownString,
  MockRange,
  MockTextDocument,
  MockTextEdit,
  MockUri,
} from './__mocks__/vscode';

// ---------------------------------------- TYPES ----------------------------------------

/** Structural shape of a registered `CodeActionsProvider` in `vscode` mock. */
interface CodeActionsProviderHandle {
  /** Queries quick-fix code actions overlapping `range` in `document`. */
  readonly provideCodeActions: (
    document: MockTextDocument,
    range: MockRange,
    context: { readonly diagnostics: readonly MockDiagnostic[] },
    token: { readonly isCancellationRequested: boolean; readonly onCancellationRequested: unknown }
  ) => Promise<MockCodeAction[] | null>;
}

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

/** Structural shape of a registered `DefinitionProvider` in `vscode` mock. */
interface DefinitionProviderHandle {
  /** Queries definition location(s) at `position`. */
  readonly provideDefinition: (
    document: MockTextDocument,
    position: { readonly character: number; readonly line: number },
    token: { readonly isCancellationRequested: boolean; readonly onCancellationRequested: unknown }
  ) => Promise<unknown>;
}

/** Structural shape of a registered `DocumentSymbolProvider` in `vscode` mock. */
interface DocumentSymbolProviderHandle {
  /** Queries hierarchical document symbols for `document`. */
  readonly provideDocumentSymbols: (
    document: MockTextDocument,
    token: { readonly isCancellationRequested: boolean; readonly onCancellationRequested: unknown }
  ) => Promise<readonly unknown[] | null>;
}

/** Structural shape of a registered `DocumentSemanticTokensProvider` in `vscode` mock. */
interface SemanticTokensProviderHandle {
  /** Queries full semantic tokens for `document`. */
  readonly provideDocumentSemanticTokens: (
    document: MockTextDocument,
    token: { readonly isCancellationRequested: boolean; readonly onCancellationRequested: unknown }
  ) => Promise<{ readonly data: Uint32Array } | null>;
}

/** Structural shape of a registered `RenameProvider` in `vscode` mock. */
interface RenameProviderHandle {
  /** Validates rename target range and placeholder at `position`. */
  readonly prepareRename: (
    document: MockTextDocument,
    position: { readonly character: number; readonly line: number },
    token: { readonly isCancellationRequested: boolean; readonly onCancellationRequested: unknown }
  ) => Promise<{ readonly placeholder: string; readonly range: unknown } | undefined>;
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

/** Canonical valid `.cx` module fixture exercising comments, contracts, calls, and locals. */
const VALID_MAIN_CX = [
  '// Verification sample module.',
  '',
  '// Computes the wrapping sum of two 32-bit signed integers.',
  '@no_alloc @no_panic',
  'pub fn add_pair(left_val: i32, right_val: i32) -> i32 {',
  '    left_val +% right_val',
  '}',
  '',
  '// Entry point combining paired sums.',
  'pub fn main() -> i32 {',
  '    let total = add_pair(10, 21);',
  '    add_pair(total, total)',
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
 * Pauses for `delay` (ms) when polling asynchronous notifications or status transitions.
 *
 * @param delay   Sleep duration (ms).
 */
function sleep(delay: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

/**
 * Polls `predicate` every `20 ms` up to `timeout` (ms), throwing if not satisfied in time.
 *
 * @param predicate   Condition callback returning `true` when ready.
 * @param label       Diagnostic label included in timeout errors.
 * @param timeout     Maximum wait ceiling (ms; `5000` by default).
 */
async function waitUntil(predicate: () => boolean, label: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(20);
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

/**
 * Returns `true` when `batches` at `version` contains at least one `severity === 1` error diagnostic.
 *
 * @param batches   Recorded push diagnostic notifications.
 * @param version   Minimum document version number.
 */
function hasErrorDiagnosticsAtVersion(
  batches: readonly LspPublishDiagnosticsParams[],
  version: number
): boolean {
  const latest = batches.at(-1);
  if (latest === undefined || (latest.version !== undefined && latest.version < version)) {
    return false;
  }
  for (const diag of latest.diagnostics) {
    if (diag.severity === 1) {
      return true;
    }
  }
  return false;
}

/**
 * Awaits the `publishDiagnostics` notification at `expectedVersion` routed through `registerResolver`.
 *
 * @param registerResolver   Hook installing the diagnostic callback.
 * @param expectedVersion    Target document version to resolve on.
 */
function waitNextBenchDiagnostic(
  registerResolver: (cb: ((params: LspPublishDiagnosticsParams) => void) | undefined) => void,
  expectedVersion: number
): Promise<LspPublishDiagnosticsParams> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      registerResolver(undefined);
      reject(new Error(`Timed out waiting for push diagnostic v${expectedVersion}`));
    }, 3000);
    function handleFrame(params: LspPublishDiagnosticsParams): void {
      if (params.version !== undefined && params.version < expectedVersion) {
        registerResolver(handleFrame);
        return;
      }
      clearTimeout(timeoutId);
      resolve(params);
    }
    registerResolver(handleFrame);
  });
}

/**
 * Finds the first 0-based `(line, character)` of `ident` on a line containing `anchor` inside `text`.
 *
 * @param text     Full UTF-16 document text.
 * @param anchor   Line substring disambiguating the target site.
 * @param ident    Identifier token to point into.
 */
function findAnchoredPosition(
  text: string,
  anchor: string,
  ident: string
): { readonly character: number; readonly line: number } {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i] ?? '';
    if (lineText.includes(anchor) && lineText.includes(ident)) {
      return new Position(i, lineText.indexOf(ident) + 2);
    }
  }
  throw new Error(`Missing anchor "${anchor}" / "${ident}" in fixture.`);
}

/**
 * Finds the first `MockCodeAction` whose `title` contains `titleFragment`.
 *
 * @param actions         Candidate code actions returned by `provideCodeActions`.
 * @param titleFragment   Required substring inside `action.title`.
 */
function findActionByTitle(
  actions: readonly MockCodeAction[],
  titleFragment: string
): MockCodeAction | undefined {
  for (const action of actions) {
    if (action.title.includes(titleFragment)) {
      return action;
    }
  }
  return undefined;
}

/**
 * Finds the first wire `LspDiagnostic` whose `code` equals `expectedCode`.
 *
 * @param diagnostics    Wire diagnostics from `publishDiagnostics` or `textDocument/diagnostic`.
 * @param expectedCode   Exact bijective code string (e.g., `'W0122/ungrouped-numeric-literal'`).
 */
function findLspDiagByCode(
  diagnostics: readonly LspDiagnostic[],
  expectedCode: string
): LspDiagnostic | undefined {
  for (const diag of diagnostics) {
    if (diag.code === expectedCode) {
      return diag;
    }
  }
  return undefined;
}

/**
 * Finds the first `MockDiagnostic` whose `code` equals `expectedCode`.
 *
 * @param diagnostics    Mapped diagnostics from `MockDiagnosticCollection`.
 * @param expectedCode   Exact bijective code string (e.g., `'W0203/single-char-ident'`).
 */
function findMockDiagByCode(
  diagnostics: readonly MockDiagnostic[],
  expectedCode: string
): MockDiagnostic | undefined {
  for (const diag of diagnostics) {
    if (diag.code === expectedCode) {
      return diag;
    }
  }
  return undefined;
}

/**
 * Locates `needle` inside `sourceText` and returns its 0-based single-line `MockRange`.
 *
 * @param sourceText   Full `LF` or `CRLF` document text.
 * @param needle       Unique single-line substring to locate.
 */
function findSubstringRange(sourceText: string, needle: string): MockRange {
  const lines = sourceText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const col = (lines[i] ?? '').indexOf(needle);
    if (col !== -1) {
      return new Range(i, col, i, col + needle.length);
    }
  }
  throw new Error(`Missing substring ${JSON.stringify(needle)} in fixture.`);
}

/**
 * Asserts that `actions` includes a Quick Fix matching `titleFragment`, `isPreferred`, `expectedCode`, and `expectedText`.
 *
 * @param actions         Candidate Quick Fix actions.
 * @param docUri          Target `MockUri` edited by the Quick Fix.
 * @param titleFragment   Unique substring identifying the action title.
 * @param isPreferred     Expected `isPreferred` flag (`true` for `MachineApplicable`).
 * @param expectedCode    Expected bijective `W0xxx/slug` diagnostic code.
 * @param expectedText    Expected `newText` replacement string.
 */
function assertPrimaryQuickFix(
  actions: readonly MockCodeAction[],
  docUri: MockUri,
  titleFragment: string,
  isPreferred: boolean,
  expectedCode: string,
  expectedText: string
): void {
  const matched = findActionByTitle(actions, titleFragment);
  expect(matched).toBeDefined();
  if (matched === undefined) {
    return;
  }
  expect(matched.isPreferred).toBe(isPreferred);
  expect(matched.title.endsWith('(unsafe fix)')).toBe(!isPreferred);
  expect(matched.diagnostics?.[0]?.code).toBe(expectedCode);
  expect(matched.edit?.get(docUri)[0]?.newText).toBe(expectedText);
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
      position: { character: 7, line: 11 },
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

    expect(
      await runCorexFmtCli(
        binaryPath,
        'pub fn banner() -> str {\n    let msg = "\n    line one\n      line two\n    ";\n    msg\n}\n'
      )
    ).toBe(
      [
        'pub fn banner() -> str {',
        '    let msg = "',
        '        line one',
        '          line two',
        '        ";',
        '    msg',
        '}',
        '',
      ].join('\n')
    );
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
    await sleep(60);

    const mockState = getMockState();
    expect(mockState.providers.hover).toHaveLength(0);
    expect(mockState.providers.documentFormatting).toHaveLength(0);
    expect(mockState.statusBarItems[0]?.text).toBe('$(warning) CoreX');
    expect(mockState.statusBarItems[0]?.backgroundColor).toEqual({
      id: 'statusBarItem.warningBackground',
    });
    expect(mockState.statusBarItems[0]?.command).toBe('corex.showStatusMenu');
    const untrustedTip = readTooltipValue(mockState.statusBarItems[0]?.tooltip);
    expect(untrustedTip).toContain(
      '**CoreX** · Untrusted. <sub><span style="color:var(--vscode-descriptionForeground);">(ext v1.0.0)</span></sub>'
    );
    expect(untrustedTip).toContain(
      '<span style="color:var(--vscode-editorWarning-foreground);">$(warning) **Language Server:** Untrusted</span>'
    );
    expect(untrustedTip).toContain(
      '<span style="color:var(--vscode-editorWarning-foreground);">$(warning) **Formatter:** Untrusted</span>'
    );

    await commands.executeCommand('corex.restartServer');
    await sleep(20);
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
    expect(mockState.statusBarItems[0]?.text).toBe('$(check) CoreX');
    expect(mockState.statusBarItems[0]?.backgroundColor).toBeUndefined();
    const cliTip = readTooltipValue(mockState.statusBarItems[0]?.tooltip);
    expect(cliTip).toContain('**CoreX** · Format only');
    expect(cliTip).toContain(
      '$(circle-slash) **Language Server:** Disabled • [Start](command:corex.restartServer)'
    );
    expect(cliTip).toContain('$(check) **Formatter** • [Disable](command:corex.toggleFormat)');

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
      () => getMockState().statusBarItems[0]?.text === '$(check-all) CoreX',
      'LSP ready status bar state'
    );

    const mockState = getMockState();
    expect(mockState.commands.has('corex.fixAll')).toBe(true);
    expect(mockState.commands.has('corex.restartServer')).toBe(true);
    expect(mockState.commands.has('corex.showOutputChannel')).toBe(true);
    expect(mockState.commands.has('corex.showStatusMenu')).toBe(true);
    expect(mockState.commands.has('corex.stopServer')).toBe(true);
    expect(mockState.commands.has('corex.toggleFormat')).toBe(true);
    expect(mockState.commands.has('corex.toggleInlayHints')).toBe(true);
    const readyTip = readTooltipValue(mockState.statusBarItems[0]?.tooltip);
    expect(readyTip).toContain(
      '$(check) **Language Server** • [Restart](command:corex.restartServer) · [Stop](command:corex.stopServer)'
    );
    expect(readyTip).toContain('$(check) **Formatter** • [Disable](command:corex.toggleFormat)');
    expect(readyTip).not.toContain('corex lsp');
    expect(readyTip).not.toContain('corex fmt');
    expect(readyTip).not.toContain('--internal-core');
    expect(readyTip).not.toContain('PID');
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

    // Exercise status-bar QuickPick menu: Open Project Config -> Disable Formatter -> Stop -> Start -> Enable:
    setNextDialogChoice('Open Project Config');
    await commands.executeCommand('corex.showStatusMenu');
    expect(mockState.quickPicks.length).toBeGreaterThanOrEqual(1);
    const menuItems = mockState.quickPicks[0] as readonly {
      readonly description?: string;
      readonly kind?: number;
      readonly label: string;
    }[];
    for (const entry of menuItems) {
      expect(entry.label.includes('`')).toBe(false);
    }
    expect(menuItems[0]?.label).toBe('Actions');
    expect(menuItems[1]?.label).toBe('$(wand) Format Document');
    expect(
      menuItems.find((entry) => entry.label.includes('Open Project Config'))?.description
    ).toBe('corex.toml');
    expect(mockState.executedCommands.some((call) => call.command === 'vscode.open')).toBe(true);

    await commands.executeCommand('corex.toggleFormat');
    expect(mockState.statusBarItems[0]?.text).toBe('$(check) CoreX');

    setNextDialogChoice('Stop Language Server');
    await commands.executeCommand('corex.showStatusMenu');
    expect(mockState.statusBarItems[0]?.text).toBe('$(circle-slash) CoreX');
    expect(readTooltipValue(mockState.statusBarItems[0]?.tooltip)).toContain(
      '**CoreX** · Stopped.'
    );

    await commands.executeCommand('corex.toggleFormat');
    expect(mockState.statusBarItems[0]?.text).toBe('$(check) CoreX');

    setNextDialogChoice('Start Language Server');
    await commands.executeCommand('corex.showStatusMenu');
    await waitUntil(
      () => getMockState().statusBarItems[0]?.text === '$(check-all) CoreX',
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
      () => getMockState().statusBarItems[0]?.text === '$(check-all) CoreX',
      'nested /build/ workspace LSP ready'
    );

    const [watcher] = getMockState().watchers;
    expect(watcher).toBeDefined();
    const ignoredBuildUri = Uri.file(path.join(nestedWorkspaceDir, 'build', 'generated.cx'));
    const watchedSrcUri = Uri.file(path.join(nestedWorkspaceDir, 'src', 'watched_mod.cx'));

    watcher?.fireChange(ignoredBuildUri);
    watcher?.fireCreate(watchedSrcUri);

    await waitUntil(() => {
      for (const line of getMockState().outputChannels[0]?.lines ?? []) {
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

  it('renders 1px multiline strip-margin guides at closing quote column C > 0 across visibleRanges', async () => {
    setWorkspaceTrusted(false);
    setWorkspaceFolders([EXT_ROOT]);

    const plainNonCxDoc = openMockDocument({
      fsPath: path.join(EXT_ROOT, 'README.txt'),
      languageId: 'plaintext',
      text: 'let ignored = "\n    plain\n    ";\n',
    });
    openMockTextEditor(plainNonCxDoc);

    activate(createMockExtensionContext());
    await sleep(60);
    expect(getMockState().decorationTypes).toHaveLength(0);

    const multilineCxText = [
      'pub fn build_query() {', // 0
      '    let sql = "', // 1 (opens plain multiline with preserved indentation)
      '    SELECT', // 2 (flush header in indented block -> connected guide at col 4)
      '', // 3 (len 0 < 4 -> skipped)
      '        id', // 4 (extra space at col 4 -> triggers connected block guide at col 4)
      '    ";', // 5 (closes at colC = 4)
      '    let fmt_msg = f#"', // 6 (opens f#" multiline with preserved space at col 6)
      '       row: {id}', // 7 (space at col 6 -> guide at col 6)
      '      "#;', // 8 (closes at colC = 6)
      '    let flush_block = "', // 9 (opens flush multiline with 0 preserved spaces)
      '    flush_line_one', // 10 (no space at col 4 -> NO guide!)
      '    flush_line_two', // 11
      '    ";', // 12 (closes at colC = 4)
      '    let col_zero = "', // 13 (opens plain multiline)
      'no_margin', // 14
      '";', // 15 (closes at colC = 0 -> no strip guide)
      '}', // 16
    ].join('\n');

    const cxDoc = openMockDocument({
      fsPath: path.join(EXT_ROOT, 'multiline_guides.cx'),
      text: multilineCxText,
    });
    const cxEditor = openMockTextEditor(cxDoc);

    await waitUntil(
      () => getMockState().decorationTypes.length === 2,
      'lazy decoration type creation on .cx editor'
    );

    const [stripDeco, mutedDeco] = getMockState().decorationTypes;
    expect(stripDeco?.options.borderWidth).toBe('0 0 0 1px');
    expect(stripDeco?.options.borderStyle).toBe('dotted');
    expect(stripDeco?.options.borderColor).toEqual({ id: 'editorIndentGuide.background1' });
    expect(mutedDeco?.options.opacity).toBe('0.58');

    if (stripDeco === undefined || mutedDeco === undefined) {
      throw new Error('Expected stripGuideDecoration and mutedDimDecoration.');
    }

    expect(cxEditor.getDecorations(stripDeco)).toEqual([
      new Range(2, 4, 2, 4),
      new Range(4, 4, 4, 4),
      new Range(7, 6, 7, 6),
    ]);

    // Restrict viewport to lines 4..8; opening `"` on line 1 is paired via lookback context:
    setMockEditorVisibleRanges(cxEditor, [new Range(4, 0, 8, 9)]);
    await sleep(60);

    expect(cxEditor.getDecorations(stripDeco)).toEqual([
      new Range(4, 4, 4, 4),
      new Range(7, 6, 7, 6),
    ]);

    // Verify trailing spaces after `"` and `f"…{{…"` / nested `{…}` at EOL never misfire as multiline openers:
    changeMockDocument(
      cxDoc,
      [
        'pub fn edge_cases() {', // 0
        '    let trailing_sp = "   ', // 1: trailing spaces -> NOT multiline
        '    let _dim_after_sp = 1;', // 2: `_dim_after_sp` at [8, 21)
        '    ";', // 3: does NOT pair with line 1
        '    let esc_brace = f"escaped {{ _not_dimmed"', // 4: `{{` + closing `"` at EOL -> NOT multiline
        '    let _dim_after_esc = 2;', // 5: `_dim_after_esc` at [8, 22)
        '    let nested_brace = f"{Pt { x: 1, label: "}" }} _not_dimmed"', // 6: nested `{…}` at EOL -> NOT multiline
        '    let _dim_after_nested = 3;', // 7: `_dim_after_nested` at [8, 25)
        '    let ok_multi = "', // 8: opens genuine multiline string at EOL
        '      margin_body', // 9: preserved indent past col 4 -> strip guide at col 4
        '    ";', // 10: closes at colC = 4
        '}', // 11
      ].join('\n')
    );
    setMockEditorVisibleRanges(cxEditor, [new Range(0, 0, 11, 1)]);
    await sleep(60);

    expect(cxEditor.getDecorations(stripDeco)).toEqual([new Range(9, 4, 9, 4)]);
    expect(cxEditor.getDecorations(mutedDeco)).toEqual([
      new Range(2, 8, 2, 21),
      new Range(5, 8, 5, 22),
      new Range(7, 8, 7, 25),
    ]);

    // Verify non-backtracking O(n) decoration scan on 4000-quote unclosed f"{ adversarial lines:
    const redosStart = performance.now();
    changeMockDocument(
      cxDoc,
      [`f"{${'"'.repeat(4000)}`, `f"{${"'".repeat(4000)}`, 'let _still_dimmed = 0;'].join('\n')
    );
    await sleep(55);
    expect(performance.now() - redosStart).toBeLessThan(250);
    expect(cxEditor.getDecorations(mutedDeco)).toEqual([new Range(2, 4, 2, 17)]);

    await deactivate();
    expect(stripDeco.isDisposed).toBe(true);
    expect(mutedDeco.isDisposed).toBe(true);
  });

  it('dims pure _ = ident; discards and _unused code tokens at 0.58 opacity while skipping calls, strings, and comments', async () => {
    setWorkspaceTrusted(false);
    setWorkspaceFolders([EXT_ROOT]);

    const dimSource = [
      '/# Module header with _not_in_mod_doc', // 0
      '/| Item doc with _not_in_item_doc', // 1
      'pub fn check(_unused_arg: i32, active: i32) -> i32 {', // 2: `_unused_arg` at [13, 24)
      '    let _scratch = active + 1;', // 3: `_scratch` at [8, 16)
      '    _ = active;', // 4: `_ = active;` at [4, 15)
      '    _ = _scratch; // trailing _not_in_line_comment', // 5: `_ = _scratch;` at [4, 17)
      '    _ = run_side_effect(active);', // 6: side-effecting call -> NOT dimmed
      '    _ = ptr.*;', // 7: dereference -> NOT dimmed
      '    let plain_lit = "_not_in_plain";', // 8: inside plain string -> NOT dimmed
      '    let raw_lit = r#"raw "_not_in_raw" end"#;', // 9: inside raw string -> NOT dimmed
      '    let fmt_lit = f"head {"_not_in_nested"} _not_in_fmt";', // 10: inside f-string -> NOT dimmed
      '    /* retired _not_in_block */ let _after_block = 0;', // 11: `_after_block` at [36, 48)
      '    return active;', // 12
      '}', // 13
    ].join('\n');

    const cxDoc = openMockDocument({
      fsPath: path.join(EXT_ROOT, 'dimming_rules.cx'),
      text: dimSource,
    });
    const cxEditor = openMockTextEditor(cxDoc);

    activate(createMockExtensionContext());
    await waitUntil(
      () => getMockState().decorationTypes.length === 2,
      'mutedDimDecoration applied on .cx editor'
    );
    await sleep(50);

    const [, mutedDeco] = getMockState().decorationTypes;
    expect(mutedDeco?.options.opacity).toBe('0.58');
    if (mutedDeco === undefined) {
      throw new Error('Expected mutedDimDecoration.');
    }

    expect(cxEditor.getDecorations(mutedDeco)).toEqual([
      new Range(2, 13, 2, 24),
      new Range(3, 8, 3, 16),
      new Range(4, 4, 4, 15),
      new Range(5, 4, 5, 17),
      new Range(11, 36, 11, 48),
    ]);

    changeMockDocument(cxDoc, 'pub fn minimal(_only_one: u32) {\n    _ = _only_one;\n}\n');
    await sleep(60);

    expect(cxEditor.getDecorations(mutedDeco)).toEqual([
      new Range(0, 15, 0, 24),
      new Range(1, 4, 1, 18),
    ]);
  });

  it('logs request timeouts via onProtocolError and rejects with LSP_SERVER_CANCELED (-32802)', async () => {
    const mockDir = await mkdtemp(path.join(tmpdir(), 'corex-timeout-'));
    createdTempDirs.push(mockDir);
    const stalledServerScript = [
      'let buf = Buffer.alloc(0);',
      'function send(msg) {',
      '  const body = JSON.stringify(msg);',
      String.raw`  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);`,
      '}',
      'process.stdin.on("data", (chunk) => {',
      '  buf = Buffer.concat([buf, chunk]);',
      '  while (true) {',
      String.raw`    const sep = buf.indexOf("\r\n\r\n");`,
      '    if (sep < 0) break;',
      String.raw`    const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString("utf8"));`,
      '    if (!m) break;',
      '    const len = Number(m[1]);',
      '    if (buf.length < sep + 4 + len) break;',
      '    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString("utf8"));',
      '    buf = buf.subarray(sep + 4 + len);',
      '    if (msg.method === "initialize") {',
      '      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });',
      '    } else if (msg.method === "shutdown") {',
      '      send({ jsonrpc: "2.0", id: msg.id, result: null });',
      '    } else if (msg.method === "exit") {',
      '      process.exit(0);',
      '    }',
      '  }',
      '});',
    ].join('\n');
    await writeFile(path.join(mockDir, 'lsp'), stalledServerScript, 'utf8');

    const protocolWarnings: string[] = [];
    const session = await startLspClient({
      binaryPath: process.execPath,
      cwd: mockDir,
      onProtocolError: (summary) => {
        protocolWarnings.push(summary);
      },
      requestTimeoutMs: 40,
    });
    spawnedClients.push(session);

    let caughtErr: unknown = undefined;
    try {
      await session.request('textDocument/semanticTokens/full', {
        textDocument: { uri: Uri.file(path.join(mockDir, 'sample.cx')).toString() },
      });
    } catch (error: unknown) {
      caughtErr = error;
    }

    expect(isJsonRpcRequestError(caughtErr)).toBe(true);
    if (isJsonRpcRequestError(caughtErr)) {
      expect(caughtErr.code).toBe(LSP_SERVER_CANCELED);
      expect(caughtErr.message).toBe('Timeout');
    }
    expect(protocolWarnings).toContain('Timeout: textDocument/semanticTokens/full');
  });

  it('serves concurrent documentSymbol, semanticTokens, hover, definition, and prepareRename across dense stdlib/cx tabs', async () => {
    const openedStdlibDocs: MockTextDocument[] = [];
    for (const fileName of ['col.cx', 'str.cx', 'mem.cx', 'math.cx']) {
      const fullPath = path.join(COREX_ROOT, 'stdlib', 'cx', fileName);
      openedStdlibDocs.push(
        openMockDocument({ fsPath: fullPath, text: await readFile(fullPath, 'utf8') })
      );
    }
    const [colDoc, strDoc, memDoc, mathDoc] = openedStdlibDocs as [
      MockTextDocument,
      MockTextDocument,
      MockTextDocument,
      MockTextDocument,
    ];
    const mathText = mathDoc.getText();
    const tValPos = findAnchoredPosition(mathText, 'let err_term: f64 =', 't_val');
    const ldexpPos = findAnchoredPosition(mathText, 'return ldexp_f64(', 'ldexp_f64');

    setWorkspaceTrusted(true);
    setWorkspaceFolders([COREX_ROOT]);
    setWorkspaceConfig({ executablePath: getLiveBinaryPath(), 'lsp.enable': true });

    activate(createMockExtensionContext());
    await waitUntil(
      () => getMockState().statusBarItems[0]?.text === '$(check-all) CoreX',
      'LSP ready on COREX_ROOT with 4 dense stdlib tabs'
    );

    const mockState = getMockState();
    const docSymProvider = mockState.providers.documentSymbol[0] as DocumentSymbolProviderHandle;
    const semProvider = mockState.providers
      .documentSemanticTokens[0] as SemanticTokensProviderHandle;
    const hoverProvider = mockState.providers.hover[0] as HoverProviderHandle;
    const defProvider = mockState.providers.definition[0] as DefinitionProviderHandle;
    const renameProvider = mockState.providers.rename[0] as RenameProviderHandle;
    const { token } = createMockCancelToken();

    const burstStart = performance.now();
    const [
      colOutline,
      colSticky,
      strOutline,
      memOutline,
      mathOutline,
      mathSemTokens,
      tValHover,
      tValDef,
      tValPrepRename,
      ldexpHover,
      ldexpDef,
    ] = await Promise.all([
      docSymProvider.provideDocumentSymbols(colDoc, token),
      docSymProvider.provideDocumentSymbols(colDoc, token),
      docSymProvider.provideDocumentSymbols(strDoc, token),
      docSymProvider.provideDocumentSymbols(memDoc, token),
      docSymProvider.provideDocumentSymbols(mathDoc, token),
      semProvider.provideDocumentSemanticTokens(mathDoc, token),
      hoverProvider.provideHover(mathDoc, tValPos, token),
      defProvider.provideDefinition(mathDoc, tValPos, token),
      renameProvider.prepareRename(mathDoc, tValPos, token),
      hoverProvider.provideHover(mathDoc, ldexpPos, token),
      defProvider.provideDefinition(mathDoc, ldexpPos, token),
    ]);

    expect(performance.now() - burstStart).toBeLessThan(8000);
    expect(colOutline !== null && colOutline.length > 10).toBe(true);
    expect(colSticky?.length).toBe(colOutline?.length);
    expect(strOutline !== null && strOutline.length > 10).toBe(true);
    expect(memOutline !== null && memOutline.length > 5).toBe(true);
    expect(mathOutline !== null && mathOutline.length > 20).toBe(true);
    expect(mathSemTokens !== null && mathSemTokens.data.length > 1000).toBe(true);
    expect(tValHover).not.toBeNull();
    expect(tValDef).not.toBeNull();
    expect(tValPrepRename?.placeholder).toBe('t_val');
    expect(ldexpHover).not.toBeNull();
    expect(ldexpDef).not.toBeNull();

    // Remove `: f64` from `fn ln_f64(x: f64, /) -> f64 {` and verify red diagnostics + intact tokens/hover:
    changeMockDocument(
      mathDoc,
      mathText.replace('fn ln_f64(x: f64, /) -> f64 {', 'fn ln_f64(x, /) -> f64 {')
    );
    await waitUntil(
      () => (mockState.collections[0]?.get(mathDoc.uri)?.length ?? 0) > 0,
      'syntax error diagnostics after deleting : f64 in math.cx'
    );
    const brokenTokens = await semProvider.provideDocumentSemanticTokens(mathDoc, token);
    expect(brokenTokens?.data.length).toBeGreaterThan(1000);
    expect(await hoverProvider.provideHover(mathDoc, tValPos, token)).not.toBeNull();

    // Restore `: f64` and verify diagnostics clear and semantic tokens + hover + definition remain active:
    changeMockDocument(mathDoc, mathText);
    await waitUntil(
      () => (mockState.collections[0]?.get(mathDoc.uri)?.length ?? -1) === 0,
      'cleared diagnostics after restoring : f64 in math.cx'
    );
    const restoredTokens = await semProvider.provideDocumentSemanticTokens(mathDoc, token);
    expect(restoredTokens?.data.length).toBeGreaterThan(1000);
    expect(await hoverProvider.provideHover(mathDoc, tValPos, token)).not.toBeNull();
    expect(await defProvider.provideDefinition(mathDoc, ldexpPos, token)).not.toBeNull();
    expect((mockState.outputChannels[0]?.lines ?? []).join('\n')).not.toContain('Timeout:');
    expect((mockState.outputChannels[0]?.lines ?? []).join('\n')).not.toContain('⚠');
  }, 30_000);

  it('styles hover contract footers with theme-adaptive <sub> spans, omits (verified), suppresses operator hover, and uses log output highlighting', async () => {
    const workspaceDir = await makeTempWorkspace();
    const mainPath = path.join(workspaceDir, 'src', 'main.cx');
    await writeFile(mainPath, VALID_MAIN_CX, 'utf8');
    const mainDoc = openMockDocument({ fsPath: mainPath, text: VALID_MAIN_CX });

    setWorkspaceTrusted(true);
    setWorkspaceFolders([workspaceDir]);
    setWorkspaceConfig({ executablePath: getLiveBinaryPath(), 'lsp.enable': true });

    activate(createMockExtensionContext());
    await waitUntil(
      () => getMockState().statusBarItems[0]?.text === '$(check-all) CoreX',
      'LSP ready for hover contract footer & operator suppression test'
    );

    expect(getMockState().outputChannels[0]?.languageId).toBe('log');

    const hoverProvider = getMockState().providers.hover[0] as HoverProviderHandle;
    const { token } = createMockCancelToken();
    const fnPos = findAnchoredPosition(VALID_MAIN_CX, 'pub fn add_pair(', 'add_pair');
    const opPos = findAnchoredPosition(VALID_MAIN_CX, 'left_val +%', '+%');

    // Operator token `+%` returns `null` hover:
    expect(await hoverProvider.provideHover(mainDoc, opPos, token)).toBeNull();

    // Dark theme (`kind = 2`) wraps contract footer in `var(--vscode-descriptionForeground)` without `(verified)`:
    setActiveColorThemeKind(2);
    const darkHover = await hoverProvider.provideHover(mainDoc, fnPos, token);
    const darkMd = darkHover?.contents as MockMarkdownString | undefined;
    expect(darkMd?.supportHtml).toBe(true);
    expect(darkMd?.isTrusted).toBeUndefined();
    expect(darkMd?.value).not.toContain('(verified)');
    expect(darkMd?.value).toContain(
      '<sub><span style="color:var(--vscode-descriptionForeground);">✓ `@no_alloc`'
    );
    expect(darkMd?.value).toContain('<br>**stack:**');

    // Light theme (`kind = 1`) uses the same native `var(--vscode-descriptionForeground)` token:
    setActiveColorThemeKind(1);
    const lightHover = await hoverProvider.provideHover(mainDoc, fnPos, token);
    expect((lightHover?.contents as MockMarkdownString | undefined)?.value).toContain(
      '<sub><span style="color:var(--vscode-descriptionForeground);">✓ `@no_alloc`'
    );

    // High Contrast (`kind = 3`) uses `<sub>…</sub>` with zero color override:
    setActiveColorThemeKind(3);
    const hcHover = await hoverProvider.provideHover(mainDoc, fnPos, token);
    const hcVal = (hcHover?.contents as MockMarkdownString | undefined)?.value ?? '';
    expect(hcVal).toContain('<sub>✓ `@no_alloc`');
    expect(hcVal).not.toContain('<span style=');
  }, 20_000);
});

// --------- 5. DR-25 Linter, Quick Fixes & Ranged Sync ---------

describe('Headless corex lsp DR-25 linter diagnostics, Quick Fix code actions, and ranged didChange resilience', () => {
  it('publishes bijective W0xxx/slug Warning diagnostics (never Error) and DiagnosticTag.Unnecessary on unused items', async () => {
    const workspaceDir = await makeTempWorkspace();
    const helperPath = path.join(workspaceDir, 'src', 'helper.cx');
    const mainPath = path.join(workspaceDir, 'src', 'main.cx');
    const lintFixture = [
      'pub mod helper;',
      'use helper.spare_helper;',
      '',
      'pub fn inspect_lints() -> u32 {',
      '    let c = 0xdeadbeef_u32;',
      '    let hex_mask = 0xdead_beef_u32;',
      '    let unused_local = 42_u32;',
      '    c ^ hex_mask',
      '}',
      '',
    ].join('\n');
    await writeFile(helperPath, 'pub fn spare_helper() -> u32 {\n    1_u32\n}\n', 'utf8');
    await writeFile(mainPath, lintFixture, 'utf8');

    const mainUri = Uri.file(mainPath).toString();
    const pushedBatches: LspPublishDiagnosticsParams[] = [];

    const session = await startLspClient({
      binaryPath: getLiveBinaryPath(),
      cwd: workspaceDir,
      onPublishDiagnostics: (params) => {
        if (Uri.parse(params.uri).toString() === mainUri) {
          pushedBatches.push(params);
        }
      },
      workspaceFolders: [{ name: 'lsp-verify', uri: Uri.file(workspaceDir).toString() }],
    });
    spawnedClients.push(session);

    notifyTextDocument(session, 'didOpen', mainUri, {
      languageId: 'corex',
      text: lintFixture,
      version: 1,
    });
    await waitUntil(() => pushedBatches.length >= 1, 'DR-25 push lint diagnostics');

    const wireDiags = pushedBatches.at(-1)?.diagnostics ?? [];
    expect(wireDiags.length).toBeGreaterThanOrEqual(5);
    for (const wireDiag of wireDiags) {
      expect(wireDiag.severity).toBe(2);
      expect(wireDiag.severity).not.toBe(1);
      expect(wireDiag.source).toBe('corex');
    }

    expect(findLspDiagByCode(wireDiags, 'W0203/single-char-ident')?.tags).toBeUndefined();
    expect(findLspDiagByCode(wireDiags, 'W0122/ungrouped-numeric-literal')?.tags).toBeUndefined();
    expect(findLspDiagByCode(wireDiags, 'W0123/non-upper-hex-literal')?.tags).toBeUndefined();
    expect(findLspDiagByCode(wireDiags, 'W0402/unused-binding')?.tags).toEqual([1]);
    expect(findLspDiagByCode(wireDiags, 'W0404/unused-import')?.tags).toEqual([1]);

    const pullReport = await requestTextDocument(
      session,
      'diagnostic',
      mainUri,
      {},
      isDiagnosticReport
    );
    expect(pullReport?.kind).toBe('full');
    if (pullReport?.kind === 'full') {
      expect(findLspDiagByCode(pullReport.items, 'W0203/single-char-ident')?.severity).toBe(2);
      expect(findLspDiagByCode(pullReport.items, 'W0404/unused-import')?.tags).toEqual([1]);
    }
    await stopLspClient(session);

    // Verify extension-host mapping into 0-based `vscode.DiagnosticSeverity.Warning` (`1`, never `Error` `0`):
    setWorkspaceTrusted(true);
    setWorkspaceFolders([workspaceDir]);
    setWorkspaceConfig({ executablePath: getLiveBinaryPath(), 'lsp.enable': true });
    const openedDoc = openMockDocument({ fsPath: mainPath, text: lintFixture });

    activate(createMockExtensionContext());
    await waitUntil(
      () => (getMockState().collections[0]?.get(openedDoc.uri)?.length ?? 0) >= 5,
      'mapped VS Code Warning diagnostics in DiagnosticCollection'
    );

    const mappedDiags = getMockState().collections[0]?.get(openedDoc.uri) ?? [];
    for (const mappedDiag of mappedDiags) {
      expect(mappedDiag.severity).toBe(DiagnosticSeverity.Warning);
      expect(mappedDiag.severity).not.toBe(DiagnosticSeverity.Error);
    }
    expect(findMockDiagByCode(mappedDiags, 'W0203/single-char-ident')).toBeDefined();
    expect(findMockDiagByCode(mappedDiags, 'W0122/ungrouped-numeric-literal')).toBeDefined();
    expect(findMockDiagByCode(mappedDiags, 'W0123/non-upper-hex-literal')).toBeDefined();
    expect(findMockDiagByCode(mappedDiags, 'W0402/unused-binding')?.tags).toEqual([
      DiagnosticTag.Unnecessary,
    ]);
    expect(findMockDiagByCode(mappedDiags, 'W0404/unused-import')?.tags).toEqual([
      DiagnosticTag.Unnecessary,
    ]);
  }, 20_000);

  it('serves Quick Fix code actions with isPreferred gating, (unsafe fix) labels, and @expect suppression', async () => {
    const workspaceDir = await makeTempWorkspace();
    const fixesPath = path.join(workspaceDir, 'src', 'main.cx');
    const initialFixesCx = [
      'pub fn verify_quick_fixes() -> u32 {',
      '    let big_dec = 100000_u32;',
      '    let low_hex = 0xdead_beef_u32;',
      '    let unused_slot = 7_u32;',
      '    let lookalike_txt = "\u0421ache";',
      '    _ = lookalike_txt;',
      '    big_dec ^ low_hex',
      '}',
      '',
    ].join('\n');
    await writeFile(fixesPath, initialFixesCx, 'utf8');

    setWorkspaceTrusted(true);
    setWorkspaceFolders([workspaceDir]);
    setWorkspaceConfig({ executablePath: getLiveBinaryPath(), 'lsp.enable': true });
    const fixesDoc = openMockDocument({ fsPath: fixesPath, text: initialFixesCx });

    activate(createMockExtensionContext());
    await waitUntil(
      () => (getMockState().collections[0]?.get(fixesDoc.uri)?.length ?? 0) >= 4,
      'initial Quick Fix candidate diagnostics'
    );

    const codeActionsProvider = getMockState().providers
      .codeActions[0] as CodeActionsProviderHandle;
    const { token } = createMockCancelToken();
    const actions = await codeActionsProvider.provideCodeActions(
      fixesDoc,
      new Range(0, 0, 8, 0),
      { diagnostics: [] },
      token
    );
    expect(actions).not.toBeNull();
    if (actions === null) {
      throw new Error('Expected Quick Fix actions array.');
    }

    // [1] `MachineApplicable` (`isPreferred: true`) vs. `MaybeIncorrect` (`isPreferred: false`, `(unsafe fix)`):
    assertPrimaryQuickFix(
      actions,
      fixesDoc.uri,
      'digit-group separators',
      true,
      'W0122/ungrouped-numeric-literal',
      '100_000'
    );
    assertPrimaryQuickFix(
      actions,
      fixesDoc.uri,
      'normalize hexadecimal literal',
      true,
      'W0123/non-upper-hex-literal',
      '0xDEAD_BEEF'
    );
    assertPrimaryQuickFix(
      actions,
      fixesDoc.uri,
      'prefix the unused binding',
      false,
      'W0402/unused-binding',
      '_unused_slot'
    );
    assertPrimaryQuickFix(
      actions,
      fixesDoc.uri,
      'ambiguous Unicode character',
      false,
      'W0104/ambiguous-unicode-text',
      'C'
    );

    // [2] Secondary `@expect` suppression actions carry `isPreferred: false` for all four rules:
    for (const slug of [
      'ungrouped-numeric-literal',
      'non-upper-hex-literal',
      'unused-binding',
      'ambiguous-unicode-text',
    ]) {
      const suppressAction = findActionByTitle(actions, `Suppress \`${slug}\` with \`@expect\``);
      expect(suppressAction).toBeDefined();
      if (suppressAction !== undefined) {
        expect(suppressAction.isPreferred).toBe(false);
        expect((suppressAction.edit?.get(fixesDoc.uri).length ?? 0) > 0).toBe(true);
      }
    }

    // [2.5] `corex.fixAll` applies strictly `isPreferred` (`MachineApplicable`) fixes and skips unsafe fixes:
    openMockTextEditor(fixesDoc);
    expect(await commands.executeCommand('corex.fixAll')).toBe(true);
    expect(fixesDoc.getText()).toContain('let big_dec = 100_000_u32;');
    expect(fixesDoc.getText()).toContain('let low_hex = 0xDEAD_BEEF_u32;');
    expect(fixesDoc.getText()).toContain('let unused_slot = 7_u32;');
    expect(fixesDoc.getText()).toContain('"\u0421ache"');

    // [3] Verify in-code `@expect` suppresses fulfilled rules while `W0002` flags unfulfilled selectors:
    changeMockDocument(
      fixesDoc,
      [
        '@expect(single-char-ident, non-upper-hex-literal, reason: "RFC wire mask")',
        'pub fn verify_quick_fixes() -> u32 {',
        '    let c = 0xDEAD_BEEF_u32;',
        '    c ^ (c >> 16_u32)',
        '}',
        '',
      ].join('\n')
    );
    await waitUntil(() => {
      const currentDiags = getMockState().collections[0]?.get(fixesDoc.uri) ?? [];
      return currentDiags.length === 1 && currentDiags[0]?.code === 'W0002/unused-suppression';
    }, 'W0002 unused-suppression on unfulfilled non-upper-hex-literal selector');

    const [staleCollection] = getMockState().collections;
    const staleDiag = staleCollection?.get(fixesDoc.uri)?.[0];
    expect(staleDiag).toMatchObject({
      severity: DiagnosticSeverity.Warning,
      tags: [DiagnosticTag.Unnecessary],
    });

    const pruneActions = await codeActionsProvider.provideCodeActions(
      fixesDoc,
      new Range(0, 0, 1, 0),
      { diagnostics: [] },
      token
    );
    expect(pruneActions?.[0]?.isPreferred).toBe(true);

    changeMockDocument(
      fixesDoc,
      [
        '@expect(single-char-ident, reason: "RFC wire mask")',
        'pub fn verify_quick_fixes() -> u32 {',
        '    let c = 0xDEAD_BEEF_u32;',
        '    c ^ (c >> 16_u32)',
        '}',
        '',
      ].join('\n')
    );
    await waitUntil(
      () => (staleCollection?.get(fixesDoc.uri)?.length ?? -1) === 0,
      'zero diagnostics once @expect matches active rule set'
    );
  }, 20_000);

  it('survives LF & CRLF ranged mid-function break/restore edits and serves < 2 ms warm lint turnaround', async () => {
    const workspaceDir = await makeTempWorkspace();
    const protocolErrors: string[] = [];
    const pushedByUri = new Map<string, LspPublishDiagnosticsParams[]>();
    let pendingBenchDiagResolver: ((params: LspPublishDiagnosticsParams) => void) | undefined =
      undefined;
    let benchTargetUri = '';

    const session = await startLspClient({
      binaryPath: getLiveBinaryPath(),
      cwd: workspaceDir,
      onProtocolError: (summary) => {
        protocolErrors.push(summary);
      },
      onPublishDiagnostics: (params) => {
        const normUri = Uri.parse(params.uri).toString();
        const history = pushedByUri.get(normUri) ?? [];
        history.push(params);
        pushedByUri.set(normUri, history);
        if (normUri === benchTargetUri && pendingBenchDiagResolver !== undefined) {
          const resolver = pendingBenchDiagResolver;
          pendingBenchDiagResolver = undefined;
          resolver(params);
        }
      },
      workspaceFolders: [{ name: 'lsp-verify', uri: Uri.file(workspaceDir).toString() }],
    });
    spawnedClients.push(session);

    // [1] Ranged mid-function break-and-restore resilience across both `LF` (`\n`) and `CRLF` (`\r\n`):
    for (const [variantLabel, eolSeq] of [
      ['lf', '\n'],
      ['crlf', '\r\n'],
    ] as const) {
      const filePath = path.join(workspaceDir, 'src', `ranged_${variantLabel}.cx`);
      const cleanSource = [
        'pub fn helper_calc(val_in: i32) -> i32 {',
        '    val_in * 2_i32',
        '}',
        '',
        'pub fn compute_pipeline(seed_val: i32) -> i32 {',
        '    let step_val = helper_calc(seed_val);',
        '    step_val + 10_i32',
        '}',
        '',
      ].join(eolSeq);
      await writeFile(filePath, cleanSource, 'utf8');
      const docUri = Uri.file(filePath).toString();

      notifyTextDocument(session, 'didOpen', docUri, {
        languageId: 'corex',
        text: cleanSource,
        version: 1,
      });
      await waitUntil(
        () => hasCleanDiagnosticsAtVersion(pushedByUri.get(docUri) ?? [], 1),
        `initial clean ${variantLabel} diagnostics`
      );

      const initialTokens = await requestTextDocument(
        session,
        'semanticTokens/full',
        docUri,
        {},
        isSemanticTokensPayload
      );
      expect((initialTokens?.data.length ?? 0) > 20).toBe(true);

      const tailExprRange = findSubstringRange(cleanSource, 'step_val + 10_i32');
      const callPos = findAnchoredPosition(cleanSource, 'let step_val =', 'helper_calc');

      // Step A: Ranged mid-function syntax break (`step_val + 10_i32` -> `step_val +`):
      notifyTextDocument(session, 'didChange', docUri, {
        contentChanges: [
          {
            range: {
              end: { character: tailExprRange.end.character, line: tailExprRange.end.line },
              start: { character: tailExprRange.start.character, line: tailExprRange.start.line },
            },
            text: 'step_val +',
          },
        ],
        textDocument: { version: 2 },
      });
      await waitUntil(
        () =>
          (pushedByUri.get(docUri)?.at(-1)?.version ?? 0) >= 2 &&
          (pushedByUri.get(docUri)?.at(-1)?.diagnostics.length ?? 0) > 0,
        `syntax-error diagnostics on ${variantLabel} ranged didChange v2`
      );
      expect(pushedByUri.get(docUri)?.at(-1)?.diagnostics[0]?.severity).toBe(1);

      const [brokenHover, brokenDef, brokenSem] = await Promise.all([
        requestTextDocument(session, 'hover', docUri, { position: callPos }, isHoverPayload),
        session.request('textDocument/definition', {
          position: callPos,
          textDocument: { uri: docUri },
        }),
        requestTextDocument(session, 'semanticTokens/full', docUri, {}, isSemanticTokensPayload),
      ]);
      expect(brokenHover).not.toBeNull();
      expect(brokenDef).not.toBeNull();
      expect((brokenSem?.data.length ?? 0) > 20).toBe(true);

      // Step B: Ranged mid-function type break (`step_val +` -> `step_val + "wrong_ret_type"`):
      const typeBreakExpr = 'step_val + "wrong_ret_type"';
      notifyTextDocument(session, 'didChange', docUri, {
        contentChanges: [
          {
            range: {
              end: {
                character: tailExprRange.start.character + 'step_val +'.length,
                line: tailExprRange.start.line,
              },
              start: { character: tailExprRange.start.character, line: tailExprRange.start.line },
            },
            text: typeBreakExpr,
          },
        ],
        textDocument: { version: 3 },
      });
      await waitUntil(
        () => hasErrorDiagnosticsAtVersion(pushedByUri.get(docUri) ?? [], 3),
        `type-error diagnostics on ${variantLabel} ranged didChange v3`
      );
      const [typeErrHover, typeErrDef, typeErrSem] = await Promise.all([
        requestTextDocument(session, 'hover', docUri, { position: callPos }, isHoverPayload),
        session.request('textDocument/definition', {
          position: callPos,
          textDocument: { uri: docUri },
        }),
        requestTextDocument(session, 'semanticTokens/full', docUri, {}, isSemanticTokensPayload),
      ]);
      expect(typeErrHover).not.toBeNull();
      expect(typeErrDef).not.toBeNull();
      expect((typeErrSem?.data.length ?? 0) > 20).toBe(true);

      // Step C: Ranged mid-function restore (`step_val + "wrong_ret_type"` -> `step_val + 10_i32`) back to 0 diagnostics:
      notifyTextDocument(session, 'didChange', docUri, {
        contentChanges: [
          {
            range: {
              end: {
                character: tailExprRange.start.character + typeBreakExpr.length,
                line: tailExprRange.start.line,
              },
              start: { character: tailExprRange.start.character, line: tailExprRange.start.line },
            },
            text: 'step_val + 10_i32',
          },
        ],
        textDocument: { version: 4 },
      });
      await waitUntil(
        () => hasCleanDiagnosticsAtVersion(pushedByUri.get(docUri) ?? [], 4),
        `restored 0 diagnostics on ${variantLabel} ranged didChange v4`
      );
    }

    // [2] Measure `< 2 ms` warm incremental lint turnaround over ranged single-char `didChange` edits:
    const benchPath = path.join(workspaceDir, 'src', 'warm_lint.cx');
    const benchSource = [
      'pub fn mask_word(word_in: u32) -> u32 {',
      '    let mask_val = 0xDEAD_BEEF_u32;',
      '    word_in ^ mask_val',
      '}',
      '',
    ].join('\n');
    await writeFile(benchPath, benchSource, 'utf8');
    benchTargetUri = Uri.file(benchPath).toString();
    const beefSpan = findSubstringRange(benchSource, 'BEEF');
    const singleCharRange = {
      end: { character: beefSpan.end.character, line: beefSpan.end.line },
      start: { character: beefSpan.end.character - 1, line: beefSpan.end.line },
    };

    notifyTextDocument(session, 'didOpen', benchTargetUri, {
      languageId: 'corex',
      text: benchSource,
      version: 1,
    });
    await waitUntil(
      () => hasCleanDiagnosticsAtVersion(pushedByUri.get(benchTargetUri) ?? [], 1),
      'warm_lint initial clean didOpen'
    );

    function setBenchResolver(
      nextCb: ((params: LspPublishDiagnosticsParams) => void) | undefined
    ): void {
      pendingBenchDiagResolver = nextCb;
    }
    for (let i = 0; i < 4; i += 1) {
      const isLowerHex = i % 2 === 0;
      const nextVer = 2 + i;
      const pushWait = waitNextBenchDiagnostic(setBenchResolver, nextVer);
      notifyTextDocument(session, 'didChange', benchTargetUri, {
        contentChanges: [{ range: singleCharRange, text: isLowerHex ? 'f' : 'F' }],
        textDocument: { version: nextVer },
      });
      const diagBatch = await pushWait;
      expect(diagBatch.diagnostics).toHaveLength(isLowerHex ? 1 : 0);
    }

    // Coalesced 12-edit ranged burst (`v6..v17`) + warm `previousResultId` diagnostic pull (`< 2 ms`):
    const burstWait = waitNextBenchDiagnostic(setBenchResolver, 17);
    const burstStart = performance.now();
    for (let i = 0; i < 12; i += 1) {
      notifyTextDocument(session, 'didChange', benchTargetUri, {
        contentChanges: [{ range: singleCharRange, text: i % 2 === 0 ? 'f' : 'F' }],
        textDocument: { version: 6 + i },
      });
    }
    const burstDiag = await burstWait;
    expect((performance.now() - burstStart) / 12).toBeLessThan(2);
    expect(burstDiag.diagnostics).toHaveLength(0);

    const seedPull = await requestTextDocument(
      session,
      'diagnostic',
      benchTargetUri,
      {},
      isDiagnosticReport
    );
    expect(seedPull?.kind).toBe('full');
    let bestWarmPullElapsed = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 6; i += 1) {
      const pullStart = performance.now();
      const pullRes = await requestTextDocument(
        session,
        'diagnostic',
        benchTargetUri,
        { previousResultId: seedPull?.resultId },
        isDiagnosticReport
      );
      bestWarmPullElapsed = Math.min(bestWarmPullElapsed, performance.now() - pullStart);
      expect(pullRes?.kind).toBe('unchanged');
    }
    expect(bestWarmPullElapsed).toBeLessThan(2);
    expect(protocolErrors).toEqual([]);
    await stopLspClient(session);
  }, 25_000);

  it('reloads corex.toml [lint].disable live via FileSystemWatcher and updates open .cx diagnostics', async () => {
    const workspaceDir = await makeTempWorkspace();
    const tomlPath = path.join(workspaceDir, 'corex.toml');
    const reloadMainPath = path.join(workspaceDir, 'src', 'main.cx');
    const reloadMainSource = [
      'pub fn config_probe() -> u32 {',
      '    let c = 0xdead_beef_u32;',
      '    c ^ (c >> 16_u32)',
      '}',
      '',
    ].join('\n');
    await writeFile(reloadMainPath, reloadMainSource, 'utf8');

    setWorkspaceTrusted(true);
    setWorkspaceFolders([workspaceDir]);
    setWorkspaceConfig({ executablePath: getLiveBinaryPath(), 'lsp.enable': true });
    const reloadDoc = openMockDocument({ fsPath: reloadMainPath, text: reloadMainSource });

    activate(createMockExtensionContext());
    await waitUntil(
      () => (getMockState().collections[0]?.get(reloadDoc.uri)?.length ?? 0) === 2,
      'initial W0203 + W0123 warnings before corex.toml disable reload'
    );

    const [watcher] = getMockState().watchers;
    expect(watcher).toBeDefined();
    const tomlUri = Uri.file(tomlPath);

    await writeFile(
      tomlPath,
      [
        '[package]',
        'name = "lsp-verify"',
        'version = "0.1.0"',
        'edition = "2026"',
        '',
        '[lint]',
        'disable = ["single-char-ident"]',
        '',
      ].join('\n'),
      'utf8'
    );
    watcher?.fireChange(tomlUri);
    await waitUntil(() => {
      const activeDiags = getMockState().collections[0]?.get(reloadDoc.uri) ?? [];
      return activeDiags.length === 1 && activeDiags[0]?.code === 'W0123/non-upper-hex-literal';
    }, 'warm corex.toml reload disabling single-char-ident');

    await writeFile(
      tomlPath,
      [
        '[package]',
        'name = "lsp-verify"',
        'version = "0.1.0"',
        'edition = "2026"',
        '',
        '[lint]',
        'disable = ["W0203", "non-upper-hex-literal"]',
        '',
      ].join('\n'),
      'utf8'
    );
    watcher?.fireChange(tomlUri);
    await waitUntil(
      () => (getMockState().collections[0]?.get(reloadDoc.uri)?.length ?? -1) === 0,
      'warm corex.toml reload disabling both W0203 and non-upper-hex-literal'
    );
  }, 25_000);
});

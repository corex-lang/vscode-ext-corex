/**
 * Configuration & Logger Tests – Unit verification for `src/config.ts` and `src/utils/logger.ts`.
 *
 * Exercises untrusted setting normalization, default fallbacks, cache invalidation, server-restart
 * diffing, lazy `OutputChannel` creation, monochrome `•`/`⚠`/`✗`/`▸` formatting, and `…` truncation.
 *
 * Resets all `vscode` host mock state and singleton caches in `afterEach` for hermetic isolation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  COREX_CONFIG_SECTION,
  DEFAULT_EXTENSION_CONFIG,
  hasServerRestartConfigChange,
  invalidateConfigCache,
  isInternalCoreMode,
  isTraceServerMode,
  parseExtensionConfig,
  readExtensionConfig,
} from '@/config';
import type { ExtensionConfig } from '@/types';
import {
  disposeLogger,
  getOutputChannel,
  logError,
  logInfo,
  logTrace,
  logWarn,
  showOutputChannel,
} from '@/utils/logger';
import { getMockState, resetVscodeMock, setWorkspaceConfig } from './__mocks__/vscode';

// -------------------------------------- INTERNALS --------------------------------------

/**
 * Merges partial overrides onto `DEFAULT_EXTENSION_CONFIG`.
 *
 * @param overrides   Subset of `ExtensionConfig` fields to customize.
 */
function buildConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return { ...DEFAULT_EXTENSION_CONFIG, ...overrides };
}

// ---------------------------------------- MAIN -----------------------------------------

afterEach(() => {
  disposeLogger();
  invalidateConfigCache();
  resetVscodeMock();
});

// ---------------- Enum Guards & Normalization -----------------

describe('Configuration enum guards and parseExtensionConfig', () => {
  it('accepts exact InternalCoreMode literals and rejects malformed values', () => {
    expect(isInternalCoreMode('auto')).toBe(true);
    expect(isInternalCoreMode('always')).toBe(true);
    expect(isInternalCoreMode('never')).toBe(true);

    expect(isInternalCoreMode('AUTO')).toBe(false);
    expect(isInternalCoreMode('force')).toBe(false);
    expect(isInternalCoreMode('')).toBe(false);
    expect(isInternalCoreMode(true)).toBe(false);
    expect(isInternalCoreMode(null)).toBe(false);
    expect(isInternalCoreMode(undefined)).toBe(false);
  });

  it('accepts exact TraceServerMode literals and rejects malformed values', () => {
    expect(isTraceServerMode('off')).toBe(true);
    expect(isTraceServerMode('messages')).toBe(true);
    expect(isTraceServerMode('verbose')).toBe(true);

    expect(isTraceServerMode('debug')).toBe(false);
    expect(isTraceServerMode('VERBOSE')).toBe(false);
    expect(isTraceServerMode(0)).toBe(false);
    expect(isTraceServerMode({})).toBe(false);
  });

  it('returns canonical defaults on empty input and preserves valid overrides', () => {
    expect(COREX_CONFIG_SECTION).toBe('corex');
    expect(parseExtensionConfig({})).toEqual(DEFAULT_EXTENSION_CONFIG);

    const customConfig = parseExtensionConfig({
      enable: false,
      executablePath: '/usr/local/bin/corex',
      formatEnable: false,
      inlayHintsEnable: false,
      internalCore: 'always',
      lspEnable: false,
      traceServer: 'verbose',
    });
    expect(customConfig).toEqual({
      executablePath: '/usr/local/bin/corex',
      internalCore: 'always',
      isEnabled: false,
      isFormatEnabled: false,
      isInlayHintsEnabled: false,
      isLspEnabled: false,
      traceServer: 'verbose',
    });
  });

  it('falls back safely when untrusted config fields carry wrong runtime types', () => {
    const sanitized = parseExtensionConfig({
      enable: 'false',
      executablePath: 999,
      formatEnable: 0,
      inlayHintsEnable: null,
      internalCore: 'invalid-mode',
      lspEnable: ['no'],
      traceServer: 'everything',
    });
    expect(sanitized).toEqual(DEFAULT_EXTENSION_CONFIG);
  });
});

// -------------- Workspace Caching & Restart Diff --------------

describe('readExtensionConfig, invalidateConfigCache, and hasServerRestartConfigChange', () => {
  it('caches workspace settings until invalidateConfigCache is called', () => {
    setWorkspaceConfig({
      executablePath: '/opt/corex',
      'format.enable': false,
      'inlayHints.enable': false,
      internalCore: 'never',
      'lsp.enable': true,
      'trace.server': 'messages',
    });

    const firstSnapshot = readExtensionConfig();
    expect(firstSnapshot).toEqual({
      executablePath: '/opt/corex',
      internalCore: 'never',
      isEnabled: true,
      isFormatEnabled: false,
      isInlayHintsEnabled: false,
      isLspEnabled: true,
      traceServer: 'messages',
    });

    setWorkspaceConfig({ executablePath: '/opt/corex-v2', internalCore: 'always' });
    expect(readExtensionConfig()).toBe(firstSnapshot);

    invalidateConfigCache();
    const refreshedSnapshot = readExtensionConfig();
    expect(refreshedSnapshot).not.toBe(firstSnapshot);
    expect(refreshedSnapshot.executablePath).toBe('/opt/corex-v2');
    expect(refreshedSnapshot.internalCore).toBe('always');
  });

  it('sanitizes invalid workspace setting values read through vscode.workspace', () => {
    setWorkspaceConfig({
      enable: 123,
      executablePath: { bad: true },
      internalCore: 'sometimes',
      'trace.server': 42,
    });
    expect(readExtensionConfig()).toEqual(DEFAULT_EXTENSION_CONFIG);
  });

  it('triggers server restart strictly on executablePath, internalCore, isEnabled, or isLspEnabled changes', () => {
    const baseCfg = buildConfig();
    expect(hasServerRestartConfigChange(baseCfg, buildConfig())).toBe(false);

    expect(
      hasServerRestartConfigChange(
        baseCfg,
        buildConfig({ isFormatEnabled: false, isInlayHintsEnabled: false, traceServer: 'verbose' })
      )
    ).toBe(false);

    expect(
      hasServerRestartConfigChange(baseCfg, buildConfig({ executablePath: '/bin/corex' }))
    ).toBe(true);
    expect(hasServerRestartConfigChange(baseCfg, buildConfig({ internalCore: 'always' }))).toBe(
      true
    );
    expect(hasServerRestartConfigChange(baseCfg, buildConfig({ isEnabled: false }))).toBe(true);
    expect(hasServerRestartConfigChange(baseCfg, buildConfig({ isLspEnabled: false }))).toBe(true);
  });
});

// ------------------- Lazy Monochrome Logger -------------------

describe('Lazy OutputChannel logger (src/utils/logger.ts)', () => {
  it('defers OutputChannel allocation until first log or showOutputChannel call', () => {
    expect(getMockState().outputChannels).toHaveLength(0);
    disposeLogger();
    expect(getMockState().outputChannels).toHaveLength(0);

    const channel = getOutputChannel();
    expect(getMockState().outputChannels).toHaveLength(1);
    expect(channel.name).toBe('CoreX');
    expect(getOutputChannel()).toBe(channel);

    showOutputChannel(true);
    expect(getMockState().outputChannels[0]?.isShown).toBe(true);
    expect(getMockState().outputChannels[0]?.isLastPreserveFocus).toBe(true);

    showOutputChannel();
    expect(getMockState().outputChannels[0]?.isLastPreserveFocus).toBe(false);
  });

  it('formats info, warning, error, and JSON-RPC trace lines with monochrome Unicode glyphs', () => {
    logInfo('Language server initialized');
    logWarn('Slow workspace scan', 'took 120 ms');
    logError('Handshake failed', new Error('broken pipe'));
    logTrace('send', 'textDocument/hover (3)', '{"id":3}');
    logTrace('receive', 'initialized');

    const recordedLines = getMockState().outputChannels[0]?.lines ?? [];
    expect(recordedLines).toHaveLength(5);
    expect(recordedLines[0]).toContain('• Language server initialized');
    expect(recordedLines[1]).toContain('⚠ Slow workspace scan\ntook 120 ms');
    expect(recordedLines[2]).toContain('✗ Handshake failed\n');
    expect(recordedLines[2]).toContain('broken pipe');
    expect(recordedLines[3]).toContain('▸ -> textDocument/hover (3)\n{"id":3}');
    expect(recordedLines[4]).toContain('▸ <- initialized');
    expect(recordedLines[4]).not.toContain('\n');
  });

  it('truncates oversized error details (4096) and trace payloads (16384) with single Unicode ellipsis …', () => {
    logError('Oversized stderr', 'e'.repeat(5000));
    logTrace('receive', 'textDocument/semanticTokens/full (4)', 't'.repeat(20_000));

    const recordedLines = getMockState().outputChannels[0]?.lines ?? [];
    expect(recordedLines).toHaveLength(2);

    const errorSuffix = (recordedLines[0] ?? '').split('\n')[1] ?? '';
    expect(errorSuffix.length).toBe(4097);
    expect(errorSuffix.endsWith('…')).toBe(true);
    expect(errorSuffix.endsWith('...')).toBe(false);

    const traceSuffix = (recordedLines[1] ?? '').split('\n')[1] ?? '';
    expect(traceSuffix.length).toBe(16_385);
    expect(traceSuffix.endsWith('…')).toBe(true);
    expect(traceSuffix.endsWith('...')).toBe(false);

    const [firstChannel] = getMockState().outputChannels;
    disposeLogger();
    expect(firstChannel?.isDisposed).toBe(true);

    logInfo('Reopened after dispose');
    expect(getMockState().outputChannels).toHaveLength(2);
  });
});

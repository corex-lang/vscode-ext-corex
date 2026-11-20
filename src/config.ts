/**
 * Configuration Reader – Validated access and caching for `corex.*` workspace settings.
 *
 * Narrows untrusted VS Code `WorkspaceConfiguration` values into a strictly typed
 * `ExtensionConfig` snapshot using $O(1)$ `Set` membership guards and safe fallbacks.
 *
 * Caches the resolved snapshot until explicitly invalidated on `onDidChangeConfiguration`.
 */

import { workspace } from 'vscode';
import { isStr } from '@/client';
import type {
  ExtensionConfig,
  InternalCoreMode,
  RawExtensionConfigInput,
  TraceServerMode,
} from '@/types';

// --------------------------------------- CONSTS ----------------------------------------

/** Configuration namespace prefix in `package.json`. */
export const COREX_CONFIG_SECTION = 'corex';

/** Canonical default values matching `package.json` `contributes.configuration`. */
export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  executablePath: '',
  internalCore: 'auto',
  isEnabled: true,
  isFormatEnabled: true,
  isInlayHintsEnabled: true,
  isLspEnabled: true,
  traceServer: 'off',
};

/** Keys whose changes require restarting `corex lsp` (sorted alphabetically). */
const RESTART_KEYS = 'executablePath,internalCore,isEnabled,isLspEnabled'.split(
  ','
) as readonly (keyof ExtensionConfig)[];

/** $O(1)$ lookup set of valid `corex.internalCore` enum literals (sorted alphabetically). */
const VALID_INTERNAL_CORE_MODES: ReadonlySet<string> = new Set('always,auto,never'.split(','));

/** $O(1)$ lookup set of valid `corex.trace.server` enum literals (sorted alphabetically). */
const VALID_TRACE_SERVER_MODES: ReadonlySet<string> = new Set('messages,off,verbose'.split(','));

// -------------------------------------- INTERNALS --------------------------------------

/** Cached configuration snapshot cleared on `invalidateConfigCache()`. */
let cachedConfig: ExtensionConfig | undefined = undefined;

/**
 * Narrows an untrusted configuration value to a `boolean` with default `true`.
 *
 * @param rawValue   Untrusted value from `WorkspaceConfiguration.get`.
 */
function isTrueOrDefault(rawValue: unknown): boolean {
  return typeof rawValue === 'boolean' ? rawValue : true;
}

// ------------------------------------- PUBLIC API --------------------------------------

/**
 * Type guard checking whether `value` is a valid `InternalCoreMode` in $O(1)$ time.
 *
 * @param value   Untrusted setting value to test.
 */
export function isInternalCoreMode(value: unknown): value is InternalCoreMode {
  return isStr(value) && VALID_INTERNAL_CORE_MODES.has(value);
}

/**
 * Type guard checking whether `value` is a valid `TraceServerMode` in $O(1)$ time.
 *
 * @param value   Untrusted setting value to test.
 */
export function isTraceServerMode(value: unknown): value is TraceServerMode {
  return isStr(value) && VALID_TRACE_SERVER_MODES.has(value);
}

/**
 * Validates and normalizes raw untrusted setting values into a typed `ExtensionConfig`.
 *
 * @param rawInput   Untrusted setting values keyed by logical field name.
 */
export function parseExtensionConfig(rawInput: RawExtensionConfigInput): ExtensionConfig {
  return {
    executablePath: isStr(rawInput.executablePath) ? rawInput.executablePath : '',
    internalCore: isInternalCoreMode(rawInput.internalCore) ? rawInput.internalCore : 'auto',
    isEnabled: isTrueOrDefault(rawInput.enable),
    isFormatEnabled: isTrueOrDefault(rawInput.formatEnable),
    isInlayHintsEnabled: isTrueOrDefault(rawInput.inlayHintsEnable),
    isLspEnabled: isTrueOrDefault(rawInput.lspEnable),
    traceServer: isTraceServerMode(rawInput.traceServer) ? rawInput.traceServer : 'off',
  };
}

/** Clears the cached `ExtensionConfig` snapshot so the next `readExtensionConfig` re-queries VS Code. */
export function invalidateConfigCache(): void {
  cachedConfig = undefined;
}

/** Reads, validates, and caches all `corex.*` workspace configuration settings. */
export function readExtensionConfig(): ExtensionConfig {
  if (cachedConfig === undefined) {
    const configView = workspace.getConfiguration(COREX_CONFIG_SECTION);
    const rawExec = configView.get('executablePath');
    const rawMode = configView.get('internalCore');
    const rawTrace = configView.get('trace.server');
    cachedConfig = {
      executablePath: isStr(rawExec) ? rawExec : '',
      internalCore: isInternalCoreMode(rawMode) ? rawMode : 'auto',
      isEnabled: isTrueOrDefault(configView.get('enable')),
      isFormatEnabled: isTrueOrDefault(configView.get('format.enable')),
      isInlayHintsEnabled: isTrueOrDefault(configView.get('inlayHints.enable')),
      isLspEnabled: isTrueOrDefault(configView.get('lsp.enable')),
      traceServer: isTraceServerMode(rawTrace) ? rawTrace : 'off',
    };
  }
  return cachedConfig;
}

/**
 * Returns `true` when differences between `prevConfig` and `nextConfig` require restarting `corex lsp`.
 *
 * @param prevConfig   Previously active configuration snapshot.
 * @param nextConfig   Newly read configuration snapshot.
 */
export function hasServerRestartConfigChange(
  prevConfig: ExtensionConfig,
  nextConfig: ExtensionConfig
): boolean {
  for (const key of RESTART_KEYS) {
    if (prevConfig[key] !== nextConfig[key]) {
      return true;
    }
  }
  return false;
}

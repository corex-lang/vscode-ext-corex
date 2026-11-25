/**
 * Configuration Reader – Validated access and caching for `corex.*` workspace settings.
 *
 * Narrows untrusted VS Code `WorkspaceConfiguration` values into a strictly typed
 * `ExtensionConfig` snapshot using $O(1)$ `Set` membership guards and safe fallbacks.
 *
 * Caches the resolved snapshot until explicitly invalidated on `onDidChangeConfiguration`.
 */

import { splitCsv } from '@/binary';
import { isStr } from '@/client';
import type {
  ExtensionConfig,
  InternalCoreMode,
  RawExtensionConfigInput,
  TraceServerMode,
} from '@/types';
import { vsWorkspace } from '@/utils/logger';

// ---------------------------------------- TYPES ----------------------------------------

/** Compact positional configuration tuple `[enable, lsp, fmt, hints, execPath, internalCore, trace]`. */
export type ExtensionConfigTuple = readonly [
  boolean,
  boolean,
  boolean,
  boolean,
  string,
  InternalCoreMode,
  TraceServerMode,
];

// --------------------------------------- CONSTS ----------------------------------------

/** Configuration namespace prefix in `package.json`. */
export const COREX_CONFIG_SECTION = 'corex';

/** Setting key for explicit `corex` binary path under `corex.*`. */
export const EXEC_PATH_KEY = 'executablePath';

/** Shared `'enable'` setting suffix. */
const ENABLE_KEY = 'enable';

/** Setting key for editor inlay hints under `corex.*`. */
export const INLAY_HINTS_KEY = `inlayHints.${ENABLE_KEY}`;

/** Canonical default values matching `package.json` `contributes.configuration`. */
export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  executablePath: '',
  internalCore: 'auto',
  isEnabled: true,
  isFormatEnabled: true,
  isInlayHintsEnabled: false,
  isLspEnabled: true,
  traceServer: 'off',
};

/** Keys whose changes require restarting `corex lsp` (sorted alphabetically). */
const RESTART_KEYS = splitCsv(
  `${EXEC_PATH_KEY},internalCore,isEnabled,isLspEnabled`
) as readonly (keyof ExtensionConfig)[];

// -------------------------------------- INTERNALS --------------------------------------

/** Cached positional configuration tuple cleared on `invalidateConfigCache()`. */
let cachedTuple: ExtensionConfigTuple | undefined = undefined;

/** Cached configuration snapshot cleared on `invalidateConfigCache()`. */
let cachedConfig: ExtensionConfig | undefined = undefined;

/**
 * Builds an $O(1)$ `Set`-backed string literal type guard from a comma-separated list.
 *
 * @param csv   Comma-separated valid enum values.
 */
function buildEnumGuard<T extends string>(csv: string): (value: unknown) => value is T {
  const validSet: ReadonlySet<string> = new Set(splitCsv(csv));
  return (value): value is T => isStr(value) && validSet.has(value);
}

// ------------------------------------- PUBLIC API --------------------------------------

/** Type guard checking whether `value` is a valid `InternalCoreMode` in $O(1)$ time. */
export const isInternalCoreMode = buildEnumGuard<InternalCoreMode>('always,auto,never');

/** Type guard checking whether `value` is a valid `TraceServerMode` in $O(1)$ time. */
export const isTraceServerMode = buildEnumGuard<TraceServerMode>('messages,off,verbose');

/**
 * Validates and normalizes raw untrusted setting values into a typed `ExtensionConfig`.
 *
 * @param rawInput   Untrusted setting values keyed by logical field name.
 */
export function parseExtensionConfig(rawInput: RawExtensionConfigInput): ExtensionConfig {
  return {
    executablePath: isStr(rawInput.executablePath) ? rawInput.executablePath : '',
    internalCore: isInternalCoreMode(rawInput.internalCore) ? rawInput.internalCore : 'auto',
    isEnabled: rawInput.enable !== false,
    isFormatEnabled: rawInput.formatEnable !== false,
    isInlayHintsEnabled: rawInput.inlayHintsEnable === true,
    isLspEnabled: rawInput.lspEnable !== false,
    traceServer: isTraceServerMode(rawInput.traceServer) ? rawInput.traceServer : 'off',
  };
}

/** Clears the cached configuration snapshots so the next read re-queries VS Code. */
export function invalidateConfigCache(): void {
  cachedTuple = undefined;
  cachedConfig = undefined;
}

/** Returns the `corex` workspace configuration view from `vscode.workspace`. */
export function getCorexWorkspaceConfig() {
  return vsWorkspace.getConfiguration(COREX_CONFIG_SECTION);
}

/** Reads, validates, and caches all `corex.*` workspace settings as a compact tuple. */
export function readCfgTuple(): ExtensionConfigTuple {
  if (!cachedTuple) {
    const configView = getCorexWorkspaceConfig();
    const rawExec = configView.get(EXEC_PATH_KEY);
    const rawMode = configView.get('internalCore');
    const rawTrace = configView.get('trace.server');
    cachedTuple = [
      configView.get(ENABLE_KEY) !== false,
      configView.get(`lsp.${ENABLE_KEY}`) !== false,
      configView.get(`format.${ENABLE_KEY}`) !== false,
      configView.get(INLAY_HINTS_KEY) === true,
      isStr(rawExec) ? rawExec : '',
      isInternalCoreMode(rawMode) ? rawMode : 'auto',
      isTraceServerMode(rawTrace) ? rawTrace : 'off',
    ];
  }
  return cachedTuple;
}

/** Reads, validates, and caches all `corex.*` workspace configuration settings. */
export function readExtensionConfig(): ExtensionConfig {
  if (!cachedConfig) {
    const tuple = readCfgTuple();
    cachedConfig = {
      executablePath: tuple[4],
      internalCore: tuple[5],
      isEnabled: tuple[0],
      isFormatEnabled: tuple[2],
      isInlayHintsEnabled: tuple[3],
      isLspEnabled: tuple[1],
      traceServer: tuple[6],
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

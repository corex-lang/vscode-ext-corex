/**
 * Configuration Types – Strongly typed schema for `corex.*` workspace settings.
 *
 * Defines the validated runtime shape produced by `src/config.ts` from untrusted
 * VS Code workspace and user configuration payloads.
 *
 * All boolean flags use canonical `is*` prefixes and enum settings use closed string unions.
 */

// ---------------------------------------- TYPES ----------------------------------------

/** Policy controlling whether `--internal-core` is passed to `corex lsp` and `corex fmt`. */
export type InternalCoreMode = 'auto' | 'always' | 'never';

/** JSON-RPC 2.0 trace verbosity level emitted to the `CoreX` output channel. */
export type TraceServerMode = 'off' | 'messages' | 'verbose';

/** Validated snapshot of all `corex.*` extension configuration properties. */
export interface ExtensionConfig {
  /** Explicit path override for the `corex` binary (`corex.executablePath`). */
  readonly executablePath: string;
  /** Policy controlling `--internal-core` flag injection (`corex.internalCore`). */
  readonly internalCore: InternalCoreMode;
  /** Whether the CoreX language extension is enabled (`corex.enable`). */
  readonly isEnabled: boolean;
  /** Whether document formatting via `corex fmt` or `corex lsp` is enabled (`corex.format.enable`). */
  readonly isFormatEnabled: boolean;
  /** Whether `corex lsp` inlay hints are rendered (`corex.inlayHints.enable`). */
  readonly isInlayHintsEnabled: boolean;
  /** Whether the built-in `corex lsp` language server is enabled (`corex.lsp.enable`). */
  readonly isLspEnabled: boolean;
  /** JSON-RPC 2.0 traffic trace verbosity (`corex.trace.server`). */
  readonly traceServer: TraceServerMode;
}

/** Raw untrusted setting values accepted by `parseExtensionConfig` for deterministic testing. */
export interface RawExtensionConfigInput {
  /** Untrusted `corex.enable` value. */
  readonly enable?: unknown;
  /** Untrusted `corex.executablePath` value. */
  readonly executablePath?: unknown;
  /** Untrusted `corex.format.enable` value. */
  readonly formatEnable?: unknown;
  /** Untrusted `corex.inlayHints.enable` value. */
  readonly inlayHintsEnable?: unknown;
  /** Untrusted `corex.internalCore` value. */
  readonly internalCore?: unknown;
  /** Untrusted `corex.lsp.enable` value. */
  readonly lspEnable?: unknown;
  /** Untrusted `corex.trace.server` value. */
  readonly traceServer?: unknown;
}

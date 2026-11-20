/**
 * Binary Discovery Types – Contracts for `corex` executable lookup and toolchain root detection.
 *
 * Decouples filesystem probing inputs (`BinaryProbeEnv`) from the VS Code host API so
 * `src/binary.ts` executes identically inside the Extension Host and headless `vitest` suites.
 *
 * Explicitly configured paths fail closed (`configured-path-not-found`) without silent fallback.
 */

// ---------------------------------------- TYPES ----------------------------------------

/** Discovery tier that matched a validated `corex` executable binary. */
export type BinaryResolutionSource =
  | 'configured-path'
  | 'workspace-build'
  | 'sibling-corex'
  | 'corex-home'
  | 'user-home'
  | 'path';

/** Failure classification returned when `resolveCorexBinary` finds no valid executable. */
export type BinaryFailureReason = 'configured-path-not-found' | 'not-found';

/** Minimal filesystem stat view used to distinguish executable files from directories. */
export interface BinaryFileStat {
  /** Returns `true` when the path points to a directory. */
  readonly isDirectory: () => boolean;
  /** Returns `true` when the path points to a regular file. */
  readonly isFile: () => boolean;
  /** POSIX permission and file-type mode bits (`stat.mode`). */
  readonly mode: number;
}

/** Host environment snapshot supplied to `resolveCorexBinary` for deterministic probing. */
export interface BinaryProbeEnv {
  /** Process environment map (`PATH` / `Path`, `PATHEXT`, `COREX_HOME`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** User home directory used for `~/` expansion and `~/.corex/bin/corex` lookup. */
  readonly homeDir?: string;
  /** Target host OS platform (`'win32'`, `'linux'`, `'darwin'`). */
  readonly platform?: NodeJS.Platform;
  /** Optional stat hook for hermetic unit tests (`null` when path does not exist). */
  readonly statFn?: (candidatePath: string) => BinaryFileStat | null;
  /** Ordered workspace root filesystem paths currently open in the editor. */
  readonly workspaceDirs: readonly string[];
}

/** Successful `corex` binary discovery result. */
export interface BinaryResolutionFound {
  /** Absolute filesystem path to the validated `corex` executable. */
  readonly binaryPath: string;
  /** Discriminant indicating a valid `corex` executable was resolved. */
  readonly isFound: true;
  /** Discovery tier that matched `binaryPath`. */
  readonly source: BinaryResolutionSource;
}

/** Failed `corex` binary discovery result. */
export interface BinaryResolutionMissing {
  /** Null path sentinel when discovery did not locate a valid executable. */
  readonly binaryPath: null;
  /** Expanded candidate path when `reason === 'configured-path-not-found'`. */
  readonly configuredCandidate?: string;
  /** Discriminant indicating binary discovery failed. */
  readonly isFound: false;
  /** Failure reason (`'configured-path-not-found'` fails closed without fallback). */
  readonly reason: BinaryFailureReason;
}

/** Discriminated union returned by `resolveCorexBinary`. */
export type BinaryResolutionResult = BinaryResolutionFound | BinaryResolutionMissing;

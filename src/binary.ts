/**
 * Binary Discovery – Host-agnostic `corex` executable lookup and `--internal-core` detection.
 *
 * Resolves the `corex` binary across explicit configuration, workspace build outputs,
 * sibling `../corex` toolchain trees, `$COREX_HOME`, `~/.corex/bin`, and `PATH`.
 *
 * Contains zero `vscode` runtime imports so headless `vitest` suites verify every tier directly,
 * enforces `<= 32` ancestor-hop caps, and fails closed when `corex.executablePath` is missing.
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
// oxlint-disable-next-line unicorn/import-style -- named imports avoid esbuild CJS __toESM wrapper overhead
import { dirname as rawDirname, join as rawJoin, resolve as rawResolve } from 'node:path';
import type {
  BinaryFileStat,
  BinaryProbeEnv,
  BinaryResolutionFound,
  BinaryResolutionMissing,
  BinaryResolutionResult,
  BinaryResolutionSource,
  InternalCoreMode,
} from '@/types';

// --------------------------------------- CONSTS ----------------------------------------

/** Shared alias binding `path.dirname` to a mangleable identifier. */
export const pathDirname = rawDirname;

/** Shared alias binding `path.join` to a mangleable identifier. */
export const pathJoin = rawJoin;

/** Canonical path resolver binding `path.resolve`. */
const resolvePath = rawResolve;

/** Whether the current Node host OS is Windows (`'win32'`). */
const IS_HOST_WIN = process.platform === 'win32';

/** Maximum parent directory hops walked upward during workspace and toolchain discovery. */
export const MAX_ANCESTOR_HOPS = 32;

/** Ordered relative build-output directories probed inside workspace and `../corex` roots. */
const BUILD_SUBDIRS = 'build/stage0,zig-out/bin,build,build/stage3,build/stage2,build/stage1'.split(
  ','
);

/** Default Windows native executable extensions checked when `env.PATHEXT` is unset. */
const DEFAULT_WINDOWS_PATHEXT = '.EXE;.COM';

/** VS Code workspace folder variable token. */
// oxlint-disable-next-line no-template-curly-in-string -- VS Code setting variable token
const WORKSPACE_FOLDER_TOKEN = '${workspaceFolder}';

// ----------------------------------- REGEX PATTERNS ------------------------------------

/** Matches POSIX (`/…`) or Windows (`C:\…`, `\\…`) absolute path prefixes without backtracking. */
const ABS_PATH_PREFIX_RX = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/;

/** Matches leading tilde home prefix (`~`, `~/…`, `~\…`) without backtracking. */
const TILDE_PREFIX_RX = /^~(?:[\\/]|$)/;

/** Matches native Windows executable extensions (`.exe`, `.com`) without `.cmd`/`.bat` shims. */
const WIN_NATIVE_EXT_RX = /\.(?:exe|com)$/i;

/** Matches any path separator or Windows drive colon in a configured path. */
const PATH_SEP_RX = /[\\/:]/;

// -------------------------------------- INTERNALS --------------------------------------

// -------------------- Path & Stat Helpers ---------------------

/**
 * Queries `fs.statSync` safely, returning `null` on `ENOENT`, permission errors, or invalid paths.
 *
 * @param candidatePath   Filesystem path to stat.
 */
function statHostPath(candidatePath: string): BinaryFileStat | null {
  try {
    return statSync(candidatePath);
  } catch {
    return null;
  }
}

/**
 * Strips leading/trailing whitespace and matching outer `"…"` or `'…'` quotes.
 *
 * @param rawValue   Raw path or `PATH` segment string.
 */
function stripOuterQuotes(rawValue: string): string {
  const trimmed = rawValue.trim();
  const quote = trimmed.charAt(0);
  return trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed.endsWith(quote)
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

/**
 * Constructs a successful `BinaryResolutionFound` result.
 *
 * @param binaryPath   Matched executable path.
 * @param source       Discovery tier that produced `binaryPath`.
 */
function createFoundResult(
  binaryPath: string,
  source: BinaryResolutionSource
): BinaryResolutionFound {
  return { binaryPath, isFound: true, source };
}

/**
 * Constructs a fail-closed `BinaryResolutionMissing` for an explicitly configured path.
 *
 * @param configuredCandidate   Expanded explicit candidate path that failed validation.
 */
function createMissingResult(configuredCandidate: string): BinaryResolutionMissing {
  return {
    binaryPath: null,
    configuredCandidate,
    isFound: false,
    reason: 'configured-path-not-found',
  };
}

/**
 * Collects deduplicated directories walking up to `MAX_ANCESTOR_HOPS` parent hops from `startDirs`.
 *
 * @param startDirs   Initial directory paths to normalize and walk upward from.
 * @param isWindows   Whether target OS is `'win32'` (case-insensitive deduplication).
 */
function collectAncestorDirs(startDirs: readonly string[], isWindows: boolean): string[] {
  const visited = new Set<string>();
  const dirs: string[] = [];
  for (const rawStart of startDirs) {
    if (rawStart) {
      let current = resolvePath(rawStart);
      for (let hop = 0; hop <= MAX_ANCESTOR_HOPS; hop += 1) {
        const key = isWindows ? current.toLowerCase() : current;
        if (!visited.has(key)) {
          visited.add(key);
          dirs.push(current);
        }
        const parent = pathDirname(current);
        if (parent === current) {
          break;
        }
        current = parent;
      }
    }
  }
  return dirs;
}

/**
 * Searches `PATH` (`env.PATH ?? env.Path`) for an executable matching `commandName`.
 *
 * @param commandName   Bare command name (e.g., `'corex'`).
 * @param env           Environment map containing `PATH` / `Path` and `PATHEXT`.
 * @param isWindows     Whether target OS is `'win32'`.
 * @param isExecFile    Executable file predicate.
 */
function searchPathForCommand(
  commandName: string,
  env: Readonly<Record<string, string | undefined>>,
  isWindows: boolean,
  isExecFile: (filePath: string) => boolean
): string | null {
  const rawPath = env.PATH ?? env.Path;
  if (!rawPath) {
    return null;
  }
  const suffixes = new Set<string>();
  if (isWindows && !WIN_NATIVE_EXT_RX.test(commandName)) {
    for (const part of (env.PATHEXT ?? env.Pathext ?? DEFAULT_WINDOWS_PATHEXT).split(';')) {
      const cleanExt = part.trim().toLowerCase();
      const dottedExt = cleanExt.startsWith('.') ? cleanExt : `.${cleanExt}`;
      if (WIN_NATIVE_EXT_RX.test(dottedExt)) {
        suffixes.add(dottedExt);
      }
    }
    suffixes.add('.exe');
  }
  suffixes.add('');

  for (const rawDir of rawPath.split(isWindows ? ';' : ':')) {
    const cleanDir = stripOuterQuotes(rawDir);
    if (cleanDir) {
      for (const suffix of suffixes) {
        const fullPath = pathJoin(cleanDir, commandName + suffix);
        if (isExecFile(fullPath)) {
          return resolvePath(fullPath);
        }
      }
    }
  }
  return null;
}

/**
 * Resolves an explicitly configured `corex.executablePath`, failing closed when missing.
 *
 * @param unquoted           Trimmed and unquoted `corex.executablePath` string.
 * @param primaryWorkspace   First workspace root directory, if any.
 * @param homeDir            User home directory.
 * @param env                Environment variable map.
 * @param isWindows          Whether target OS is `'win32'`.
 * @param isExecFile         Executable file predicate.
 */
function resolveConfiguredBinary(
  unquoted: string,
  primaryWorkspace: string | undefined,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  isWindows: boolean,
  isExecFile: (filePath: string) => boolean
): BinaryResolutionResult {
  const resolvedWorkspace = primaryWorkspace ? resolvePath(primaryWorkspace) : undefined;
  let expanded = unquoted;
  if (TILDE_PREFIX_RX.test(expanded)) {
    if (!homeDir) {
      return createMissingResult(unquoted);
    }
    expanded = pathJoin(homeDir, expanded.slice(2));
  }
  if (expanded.includes(WORKSPACE_FOLDER_TOKEN)) {
    if (!resolvedWorkspace) {
      return createMissingResult(unquoted);
    }
    expanded = expanded.replaceAll(WORKSPACE_FOLDER_TOKEN, resolvedWorkspace);
  }

  if (!PATH_SEP_RX.test(expanded)) {
    const fromPath = searchPathForCommand(expanded, env, isWindows, isExecFile);
    return fromPath
      ? createFoundResult(fromPath, 'configured-path')
      : createMissingResult(expanded);
  } else if (!resolvedWorkspace && !ABS_PATH_PREFIX_RX.test(expanded)) {
    return createMissingResult(expanded);
  }

  const candidate = resolvePath(resolvedWorkspace ?? '', expanded);
  const fullPath = isWindows && !WIN_NATIVE_EXT_RX.test(candidate) ? `${candidate}.exe` : candidate;
  return isExecFile(fullPath)
    ? createFoundResult(fullPath, 'configured-path')
    : createMissingResult(candidate);
}

// ------------------------------------- PUBLIC API --------------------------------------

/**
 * Returns `true` when `dirPath` is the CoreX compiler/stdlib repository root (`core/root.cx` + `stage0/` or `compiler/`).
 *
 * @param dirPath      Candidate directory path to inspect.
 * @param statLookup   Optional stat function override for unit tests.
 */
export function isCorexToolchainRoot(
  dirPath: string,
  statLookup: (candidatePath: string) => BinaryFileStat | null = statHostPath
): boolean {
  return Boolean(
    statLookup(pathJoin(dirPath, 'core/root.cx'))?.isFile() &&
    (statLookup(pathJoin(dirPath, 'stage0'))?.isDirectory() ||
      statLookup(pathJoin(dirPath, 'compiler'))?.isDirectory())
  );
}

/**
 * Determines whether `--internal-core` should be passed to `corex lsp` and `corex fmt`.
 *
 * @param mode            Configured `corex.internalCore` policy (`'auto'`, `'always'`, `'never'`).
 * @param workspaceDirs   Active workspace root directories.
 * @param openFilePaths   Optional open `.cx` file paths consulted only when `workspaceDirs` is empty.
 * @param statLookup      Optional stat function override for unit tests.
 */
export function isInternalCoreEnabled(
  mode: InternalCoreMode,
  workspaceDirs: readonly string[],
  openFilePaths: readonly string[] = [],
  statLookup: (candidatePath: string) => BinaryFileStat | null = statHostPath
): boolean {
  if (mode !== 'auto') {
    return mode === 'always';
  }
  const hasWorkspaces = workspaceDirs.length > 0;
  const seeds: string[] = [];
  for (const item of hasWorkspaces ? workspaceDirs : openFilePaths) {
    if (item) {
      seeds.push(hasWorkspaces ? item : pathDirname(resolvePath(item)));
    }
  }
  for (const dirPath of collectAncestorDirs(seeds, IS_HOST_WIN)) {
    if (isCorexToolchainRoot(dirPath, statLookup)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the `corex` executable path across explicit settings, workspace builds, `$COREX_HOME`, `~/.corex`, and `PATH`.
 *
 * @param configuredPath   Raw `corex.executablePath` setting value.
 * @param probeEnv         Workspace roots, environment variables, and platform metadata.
 */
export function resolveCorexBinary(
  configuredPath: string,
  probeEnv: BinaryProbeEnv = { workspaceDirs: [] }
): BinaryResolutionResult {
  const { env = process.env, homeDir = homedir(), statFn, workspaceDirs } = probeEnv;
  const isWindows = probeEnv.platform ? probeEnv.platform === 'win32' : IS_HOST_WIN;
  const hasPosixBits = !isWindows && (statFn !== undefined || !IS_HOST_WIN);
  const statLookup = statFn ?? statHostPath;

  /** Returns `true` when `filePath` is a native executable file (rejecting `.cmd`/`.bat` shims on Windows). */
  function isExecFile(filePath: string): boolean {
    const stat = (!isWindows || WIN_NATIVE_EXT_RX.test(filePath)) && statLookup(filePath);
    // oxlint-disable-next-line no-bitwise -- POSIX execute-permission bitmask check
    return Boolean(stat && stat.isFile() && (!hasPosixBits || (stat.mode & 0o111) !== 0));
  }

  const unquoted = stripOuterQuotes(configuredPath);
  if (unquoted) {
    return resolveConfiguredBinary(unquoted, workspaceDirs[0], homeDir, env, isWindows, isExecFile);
  }

  const binaryName = isWindows ? 'corex.exe' : 'corex';
  const siblingSeeds: string[] = [];
  for (const workspaceDir of workspaceDirs) {
    if (workspaceDir) {
      siblingSeeds.push(resolvePath(workspaceDir, '..', 'corex'));
    }
  }

  for (const [roots, subDirs, source] of [
    [collectAncestorDirs(workspaceDirs, isWindows), BUILD_SUBDIRS, 'workspace-build'],
    [siblingSeeds, BUILD_SUBDIRS, 'sibling-corex'],
    [env.COREX_HOME ? [stripOuterQuotes(env.COREX_HOME)] : [], ['bin'], 'corex-home'],
    [[homeDir], ['.corex/bin'], 'user-home'],
  ] as const) {
    for (const rootDir of roots) {
      if (rootDir) {
        for (const subDir of subDirs) {
          const candidate = resolvePath(rootDir, subDir, binaryName);
          if (isExecFile(candidate)) {
            return createFoundResult(candidate, source);
          }
        }
      }
    }
  }

  const pathMatch = searchPathForCommand('corex', env, isWindows, isExecFile);
  return pathMatch
    ? createFoundResult(pathMatch, 'path')
    : { binaryPath: null, isFound: false, reason: 'not-found' };
}

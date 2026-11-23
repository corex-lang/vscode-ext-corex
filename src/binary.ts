/**
 * Binary Discovery – Host-agnostic `corex` executable lookup and `--internal-core` detection.
 *
 * Resolves the `corex` binary across explicit configuration, workspace build outputs,
 * sibling `../corex` toolchain trees, `$COREX_HOME`, `~/.corex/bin`, and `PATH`.
 *
 * Contains zero `vscode` runtime imports so headless `vitest` suites verify every tier directly,
 * enforces `<= 32` ancestor-hop caps, and fails closed when `corex.executablePath` is missing.
 */

import { statSync as rawStatSync } from 'node:fs';
import { homedir as rawHomedir, tmpdir as rawTmpdir } from 'node:os';
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

/** Local alias binding `fs.statSync`. */
const hostStatSync = rawStatSync;

/** Local alias binding `os.homedir`. */
const hostHomedir = rawHomedir;

/** Whether the current Node host OS is Windows (`'win32'`). */
const IS_HOST_WIN = process.platform === 'win32';

/** Maximum parent directory hops walked upward during workspace and toolchain discovery. */
export const MAX_ANCESTOR_HOPS = 32;

/** Ordered relative build-output directories probed inside workspace and `../corex` roots. */
const BUILD_SUBDIRS = 'build/stage0,zig-out/bin,build,build/stage3,build/stage2,build/stage1'.split(
  ','
);

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
    return hostStatSync(candidatePath);
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
  const [quote] = trimmed;
  return (quote === '"' || quote === "'") && trimmed.length > 1 && trimmed.endsWith(quote)
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
  source: BinaryResolutionSource = 'configured-path'
): BinaryResolutionFound {
  return { binaryPath, isFound: true, source };
}

/**
 * Constructs a `BinaryResolutionMissing` result (`configured-path-not-found` when a candidate is given).
 *
 * @param configuredCandidate   Optional explicit candidate path that failed validation.
 */
function createMissingResult(configuredCandidate?: string): BinaryResolutionMissing {
  return {
    binaryPath: null,
    ...(configuredCandidate !== undefined && { configuredCandidate }),
    isFound: false,
    reason: configuredCandidate === undefined ? 'not-found' : 'configured-path-not-found',
  } as BinaryResolutionMissing;
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
    let current = rawStart && resolvePath(rawStart);
    for (let hop = 0; current && hop <= MAX_ANCESTOR_HOPS; hop += 1) {
      const key = isWindows ? current.toLowerCase() : current;
      if (!visited.has(key)) {
        visited.add(key);
        dirs.push(current);
      }
      const parent = pathDirname(current);
      current = parent === current ? '' : parent;
    }
  }
  return dirs;
}

// ------------------------------------- PUBLIC API --------------------------------------

/** Returns the host OS temporary directory path. */
export function getHostTmpdir(): string {
  return rawTmpdir();
}

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
  const { env = process.env, homeDir = hostHomedir(), statFn, workspaceDirs } = probeEnv;
  const isWindows = (probeEnv.platform ?? process.platform) === 'win32';
  const hasPosixBits = !isWindows && (statFn !== undefined || !IS_HOST_WIN);
  const statLookup = statFn ?? statHostPath;

  /** Returns `true` when `filePath` is a native executable file (rejecting `.cmd`/`.bat` shims on Windows). */
  function isExecFile(filePath: string): boolean {
    const stat = (!isWindows || WIN_NATIVE_EXT_RX.test(filePath)) && statLookup(filePath);
    // oxlint-disable-next-line no-bitwise -- POSIX execute-permission bitmask check
    return Boolean(stat && stat.isFile() && (!hasPosixBits || stat.mode & 0o111));
  }

  /** Searches `PATH` (`env.PATH ?? env.Path`) for an executable matching `commandName`. */
  function searchPath(commandName: string): string | null {
    const rawPath = env.PATH ?? env.Path;
    if (!rawPath) {
      return null;
    }
    const suffixes = new Set<string>();
    if (isWindows && !WIN_NATIVE_EXT_RX.test(commandName)) {
      for (const part of (env.PATHEXT ?? env.Pathext ?? '.exe;.com').split(';')) {
        const dottedExt = part.trim().toLowerCase().replace(/^\.?/, '.');
        if (WIN_NATIVE_EXT_RX.test(dottedExt)) {
          suffixes.add(dottedExt);
        }
      }
      suffixes.add('.exe');
    }
    suffixes.add('');
    for (const rawDir of rawPath.split(isWindows ? ';' : ':')) {
      const cleanDir = stripOuterQuotes(rawDir);
      for (const suffix of cleanDir ? suffixes : []) {
        const fullPath = resolvePath(cleanDir, commandName + suffix);
        if (isExecFile(fullPath)) {
          return fullPath;
        }
      }
    }
    return null;
  }

  /** Resolves an explicitly configured `corex.executablePath`, failing closed when missing. */
  function resolveConfigured(unquoted: string): BinaryResolutionResult {
    const resolvedWorkspace = workspaceDirs[0] ? resolvePath(workspaceDirs[0]) : undefined;
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
      const fromPath = searchPath(expanded);
      return fromPath ? createFoundResult(fromPath) : createMissingResult(expanded);
    } else if (!resolvedWorkspace && !ABS_PATH_PREFIX_RX.test(expanded)) {
      return createMissingResult(expanded);
    }
    const candidate = resolvePath(resolvedWorkspace ?? '', expanded);
    const fullPath =
      isWindows && !WIN_NATIVE_EXT_RX.test(candidate) ? `${candidate}.exe` : candidate;
    return isExecFile(fullPath) ? createFoundResult(fullPath) : createMissingResult(candidate);
  }

  const unquoted = stripOuterQuotes(configuredPath);
  if (unquoted) {
    return resolveConfigured(unquoted);
  }

  const binaryName = isWindows ? 'corex.exe' : 'corex';
  for (const [roots, prefix, subDirs, source] of [
    [collectAncestorDirs(workspaceDirs, isWindows), '', BUILD_SUBDIRS, 'workspace-build'],
    [workspaceDirs, '../corex', BUILD_SUBDIRS, 'sibling-corex'],
    [env.COREX_HOME ? [stripOuterQuotes(env.COREX_HOME)] : [], '', ['bin'], 'corex-home'],
    [[homeDir], '', ['.corex/bin'], 'user-home'],
  ] as const) {
    for (const rootDir of roots) {
      if (rootDir) {
        for (const subDir of subDirs) {
          const candidate = resolvePath(rootDir, prefix, subDir, binaryName);
          if (isExecFile(candidate)) {
            return createFoundResult(candidate, source);
          }
        }
      }
    }
  }

  const pathMatch = searchPath('corex');
  return pathMatch ? createFoundResult(pathMatch, 'path') : createMissingResult();
}

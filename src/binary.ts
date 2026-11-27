/**
 * Binary Discovery – Host-agnostic `corex` executable lookup and `--internal-core` detection.
 *
 * Resolves the `corex` binary across explicit configuration, workspace build outputs,
 * sibling `../corex` toolchain trees, `$COREX_HOME`, `~/.corex/bin`, and `PATH`.
 *
 * Contains zero `vscode` runtime imports so headless `vitest` suites verify every tier directly,
 * enforces `<= 32` ancestor-hop caps, and fails closed when `corex.executablePath` is missing.
 */

// oxlint-disable-next-line unicorn/prefer-export-from -- value binding avoids esbuild CJS getter re-export overhead
import { promises, statSync } from 'node:fs';
// oxlint-disable-next-line unicorn/prefer-export-from -- value binding avoids esbuild CJS getter re-export overhead
import { homedir, tmpdir } from 'node:os';
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

/** Shared alias binding `fs.promises` so downstream modules share one `node:fs` import. */
export const fsAsync = promises;

/** Local alias binding `fs.statSync` to avoid CJS indirect-call wrappers. */
const rawStatSync = statSync;

/** Local alias binding `os.homedir` to avoid CJS indirect-call wrappers. */
const getHomeDir = homedir;

/** Returns the host OS temporary directory path. */
export const getHostTmpdir = tmpdir;

/** Shared alias binding `path.dirname` to a mangleable identifier. */
export const pathDirname = rawDirname;

/** Shared alias binding `path.join` to a mangleable identifier. */
export const pathJoin = rawJoin;

/** Shared alias binding `Math.max` and `Math.min` to mangleable identifiers. */
export const { max: numMax, min: numMin } = Math;

/** Shared alias binding `Object.assign` to a mangleable identifier. */
export const assignProps = Object.assign;

/** Canonical path resolver binding `path.resolve`. */
const resolvePath = rawResolve;

/** Whether the current Node host OS is Windows (`'win32'`). */
const IS_HOST_WIN = process.platform === 'win32';

/** Maximum parent directory hops walked upward during workspace and toolchain discovery. */
export const MAX_ANCESTOR_HOPS = 32;

/** Shared `'not-found'` reason suffix. */
export const NOT_FOUND_REASON = 'not-found';

/** Shared `'configured-path'` binary discovery source literal. */
const SRC_CFG: BinaryResolutionSource = 'configured-path';

/** Ordered build subdirectories probed relative to `<root>/build` (`../zig-out/bin` escapes `build/`). */
const BUILD_SUBDIRS = 'stage0,../zig-out/bin,,stage3,stage2,stage1'.split(',');

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

/** Matches outer matching `"…"` or `'…'` quotes around a non-empty string without backtracking. */
// oxlint-disable-next-line prefer-named-capture-group -- positional backreference avoids unmangleable group keys under 25 KB bundle budget
const OUTER_QUOTES_RX = /^(['"])(.+)\1$/;

// -------------------------------------- INTERNALS --------------------------------------

// -------------------- Path & Stat Helpers ---------------------

/**
 * Queries `fs.statSync` safely, returning `null` on `ENOENT`, permission errors, or invalid paths.
 *
 * @param candidatePath   Filesystem path to stat.
 */
function statHostPath(candidatePath: string): BinaryFileStat | null {
  try {
    return rawStatSync(candidatePath);
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
  return OUTER_QUOTES_RX.exec(trimmed)?.[2]?.trim() ?? trimmed;
}

/**
 * Converts a nullable candidate hit into a `BinaryResolutionResult`.
 *
 * @param hit      Matched executable path, or falsy when missing.
 * @param miss     Optional explicit configured path that failed validation.
 * @param source   Discovery tier that produced `hit` (`'configured-path'` by default).
 */
function finishProbe(
  hit: string | false | null,
  miss?: string,
  source: BinaryResolutionSource = SRC_CFG
): BinaryResolutionResult {
  return hit
    ? ({ binaryPath: hit, isFound: true, source } as BinaryResolutionFound)
    : ({
        binaryPath: null,
        ...(miss && { configuredCandidate: miss }),
        isFound: false,
        reason: miss ? `${SRC_CFG}-${NOT_FOUND_REASON}` : NOT_FOUND_REASON,
      } as BinaryResolutionMissing);
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
    for (
      let current = rawStart && resolvePath(rawStart), hop = 0;
      current && hop <= MAX_ANCESTOR_HOPS;
      hop += 1
    ) {
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

/**
 * Walks up to `MAX_ANCESTOR_HOPS` parent directories from `seedDirs`, returning the first truthy `visit` match.
 *
 * @param seedDirs   Initial directories to walk upward from.
 * @param visit      Visitor returning a truthy match or falsy to continue.
 */
function findInAncestors<T>(
  seedDirs: readonly string[],
  visit: (dirPath: string) => T | false | null | undefined
): T | undefined {
  for (const dirPath of collectAncestorDirs(seedDirs, IS_HOST_WIN)) {
    const hit = visit(dirPath);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

// ------------------------------------- PUBLIC API --------------------------------------

/** Shared no-op callback avoiding repeated empty arrow allocations. */
export function noop(): void {
  // Intentionally empty callback.
}

/**
 * Splits a comma-separated literal table into an array of strings.
 *
 * @param csv   Comma-delimited string literal.
 */
export function splitCsv(csv: string): string[] {
  return csv.split(',');
}

/**
 * Walks up to `MAX_ANCESTOR_HOPS` parent directories from `seedDirs` to locate the nearest `corex.toml`.
 *
 * @param seedDirs   Initial file/workspace directories to search upward from.
 */
export function findProjectToml(seedDirs: readonly string[]): string | undefined {
  return findInAncestors(seedDirs, (dirPath) => {
    const candidate = pathJoin(dirPath, 'corex.toml');
    return statHostPath(candidate)?.isFile() && candidate;
  });
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
  const [rootCx, stage0Dir, compilerDir] = splitCsv('core/root.cx,stage0,compiler').map((sub) =>
    statLookup(pathJoin(dirPath, sub))
  );
  return Boolean(rootCx?.isFile() && (stage0Dir?.isDirectory() || compilerDir?.isDirectory()));
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
  return (
    mode === 'always' ||
    (mode === 'auto' &&
      Boolean(
        findInAncestors(
          workspaceDirs[0]
            ? workspaceDirs
            : openFilePaths.map((filePath) => filePath && pathDirname(resolvePath(filePath))),
          (dirPath) => isCorexToolchainRoot(dirPath, statLookup)
        )
      ))
  );
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
  const {
    env = process.env,
    homeDir = getHomeDir(),
    platform = process.platform,
    statFn,
    workspaceDirs,
  } = probeEnv;
  const isWindows = platform === 'win32';
  const checkStat = statFn ?? statHostPath;
  const hasPosixBits = !isWindows && (Boolean(statFn) || !IS_HOST_WIN);

  /** Returns `true` when `filePath` is a native executable file (rejecting `.cmd`/`.bat` shims on Windows). */
  function isExecFile(filePath: string): boolean {
    const stat = (!isWindows || WIN_NATIVE_EXT_RX.test(filePath)) && checkStat(filePath);
    // oxlint-disable-next-line no-bitwise -- POSIX execute-permission bitmask check
    return Boolean(stat && stat.isFile() && (!hasPosixBits || stat.mode & 0o111));
  }

  /** Searches `PATH` (`env.PATH ?? env.Path`) for an executable matching `commandName`. */
  function searchPath(commandName: string): string | null {
    const suffixes = new Set(
      isWindows && !WIN_NATIVE_EXT_RX.test(commandName)
        ? `${env.PATHEXT ?? env.Pathext ?? ''};.exe;.com`
            .toLowerCase()
            .split(';')
            .map((ext) => `.${ext.trim()}`.replace('..', '.'))
            .filter((ext) => WIN_NATIVE_EXT_RX.test(ext))
        : []
    ).add('');
    for (const rawDir of (env.PATH ?? env.Path ?? '').split(isWindows ? ';' : ':')) {
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

  /** Resolves a non-empty `corex.executablePath` setting value. */
  function resolveConfigured(unquoted: string): BinaryResolutionResult {
    const workspaceRoot = workspaceDirs[0] ? resolvePath(workspaceDirs[0]) : '';
    const hasTilde = TILDE_PREFIX_RX.test(unquoted);
    if ((hasTilde && !homeDir) || (unquoted.includes(WORKSPACE_FOLDER_TOKEN) && !workspaceRoot)) {
      return finishProbe(null, unquoted);
    }
    const expanded = (hasTilde ? pathJoin(homeDir, unquoted.slice(2)) : unquoted).replaceAll(
      WORKSPACE_FOLDER_TOKEN,
      workspaceRoot
    );
    if (!PATH_SEP_RX.test(expanded)) {
      return finishProbe(searchPath(expanded), expanded);
    }
    const candidate =
      workspaceRoot || ABS_PATH_PREFIX_RX.test(expanded)
        ? resolvePath(workspaceRoot, expanded)
        : '';
    const fullPath =
      candidate && isWindows && !WIN_NATIVE_EXT_RX.test(candidate) ? `${candidate}.exe` : candidate;
    return finishProbe(isExecFile(fullPath) && fullPath, candidate || expanded);
  }

  const unquoted = stripOuterQuotes(configuredPath);
  if (unquoted) {
    return resolveConfigured(unquoted);
  }

  const binaryName = `corex${isWindows ? '.exe' : ''}`;
  for (const [roots, prefix, source, subDirs = ['']] of [
    [collectAncestorDirs(workspaceDirs, isWindows), 'build', 'workspace-build', BUILD_SUBDIRS],
    [workspaceDirs, '../corex/build', 'sibling-corex', BUILD_SUBDIRS],
    [[stripOuterQuotes(env.COREX_HOME ?? '')], 'bin', 'corex-home'],
    [[homeDir], '.corex/bin', 'user-home'],
  ] as const) {
    for (const rootDir of roots) {
      for (const subDir of rootDir ? subDirs : []) {
        const candidate = resolvePath(rootDir, prefix, subDir, binaryName);
        if (isExecFile(candidate)) {
          return finishProbe(candidate, undefined, source);
        }
      }
    }
  }

  return finishProbe(searchPath('corex'), undefined, 'path');
}

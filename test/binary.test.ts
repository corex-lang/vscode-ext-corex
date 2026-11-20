/**
 * Binary Discovery & Toolchain Detection Tests – Unit and host verification for `src/binary.ts`.
 *
 * Verifies all 5 discovery tiers (`configured-path`, `workspace-build`, `sibling-corex`,
 * `corex-home` / `user-home`, and `PATH`), fail-closed `configured-path-not-found` behavior,
 * `MAX_ANCESTOR_HOPS` (`32`), POSIX `0o111` mode checks, and `--internal-core` root detection.
 *
 * Combines hermetic `statFn` virtual filesystems across `'linux'` and `'win32'` with live
 * host assertions against the sibling `../corex` repository.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isCorexToolchainRoot,
  isInternalCoreEnabled,
  MAX_ANCESTOR_HOPS,
  resolveCorexBinary,
} from '@/binary';
import type { BinaryFileStat } from '@/types';

// ---------------------------------------- TYPES ----------------------------------------

/** Virtual filesystem entry kind for hermetic `statFn` fixtures. */
type VirtualEntryKind = 'dir' | 'exec' | 'file644';

// --------------------------------------- CONSTS ----------------------------------------

/** Extension repository root (`D:\GitHub\vscode-ext-corex`). */
const EXT_REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Sibling CoreX compiler repository root (`D:\GitHub\corex`). */
const COREX_REPO_ROOT = path.resolve(EXT_REPO_ROOT, '..', 'corex');

/** Expected live Stage-0 compiler binary path inside the sibling `corex` repository. */
const LIVE_STAGE0_BINARY = path.resolve(
  COREX_REPO_ROOT,
  'build',
  'stage0',
  process.platform === 'win32' ? 'corex.exe' : 'corex'
);

/** VS Code workspace-folder substitution variable token. */
// oxlint-disable-next-line no-template-curly-in-string -- VS Code setting variable token under test
const WORKSPACE_FOLDER_VAR = '${workspaceFolder}';

// ----------------------------------- REGEX PATTERNS ------------------------------------

/** Matches backslashes for cross-platform virtual path normalization without backtracking. */
const BACKSLASH_RX = /\\/g;

/** Matches trailing slashes (except root `/`) for virtual stat lookup normalization. */
const TRAILING_SLASH_RX = /(?<=.)\/+$/;

// -------------------------------------- INTERNALS --------------------------------------

/**
 * Normalizes a filesystem candidate path into a canonical lookup key for hermetic `statFn` maps.
 *
 * @param rawPath     Candidate path passed by `resolveCorexBinary`.
 * @param isWindows   Whether lookup keys should be compared case-insensitively.
 */
function normalizeVirtualKey(rawPath: string, isWindows: boolean): string {
  const resolved = path.resolve(rawPath).replace(BACKSLASH_RX, '/').replace(TRAILING_SLASH_RX, '');
  return isWindows ? resolved.toLowerCase() : resolved;
}

/**
 * Builds a deterministic `statFn` lookup function from virtual path entries.
 *
 * @param entries     Map of virtual paths to `'exec'` (`0o755` file), `'file644'` (`0o644` file), or `'dir'`.
 * @param isWindows   Whether path matching is case-insensitive.
 */
function createVirtualStat(
  entries: Readonly<Record<string, VirtualEntryKind>>,
  isWindows = false
): (candidatePath: string) => BinaryFileStat | null {
  const table = new Map<string, BinaryFileStat>();
  for (const [rawKey, entryKind] of Object.entries(entries)) {
    const statRecord: BinaryFileStat =
      entryKind === 'dir'
        ? { isDirectory: () => true, isFile: () => false, mode: 0o755 }
        : {
            isDirectory: () => false,
            isFile: () => true,
            mode: entryKind === 'exec' ? 0o755 : 0o644,
          };
    table.set(normalizeVirtualKey(rawKey, isWindows), statRecord);
  }
  return (candidatePath: string): BinaryFileStat | null =>
    table.get(normalizeVirtualKey(candidatePath, isWindows)) ?? null;
}

/**
 * Builds a nested directory path `depth` levels beneath `baseDir`.
 *
 * @param baseDir   Root ancestor directory.
 * @param depth     Number of child directory segments to append.
 */
function buildNestedDir(baseDir: string, depth: number): string {
  const segments: string[] = [baseDir];
  for (let i = 1; i <= depth; i += 1) {
    segments.push(`d${i}`);
  }
  return path.resolve(...segments);
}

// ---------------------------------------- MAIN -----------------------------------------

// ------------------ Tier 1: Configured Path -------------------

describe('Tier 1 – Explicit corex.executablePath resolution and fail-closed safety', () => {
  it('resolves explicit paths, outer quotes, ~/ home prefixes, and workspaceFolder variable tokens', () => {
    const homeDir = path.resolve('/virt-home/alice');
    const workspaceDir = path.resolve('/virt-work/demo-app');
    const explicitBin = path.resolve('/opt/corex/bin/corex');
    const homeBin = path.resolve(homeDir, 'bin/corex');
    const workspaceToolBin = path.resolve(workspaceDir, 'tools/corex');

    const statFn = createVirtualStat({
      [explicitBin]: 'exec',
      [homeBin]: 'exec',
      [workspaceToolBin]: 'exec',
    });

    expect(
      resolveCorexBinary(explicitBin, {
        env: {},
        homeDir,
        platform: 'linux',
        statFn,
        workspaceDirs: [workspaceDir],
      })
    ).toEqual({ binaryPath: explicitBin, isFound: true, source: 'configured-path' });

    expect(
      resolveCorexBinary(`  "${explicitBin}"  `, {
        env: {},
        homeDir,
        platform: 'linux',
        statFn,
        workspaceDirs: [],
      })
    ).toEqual({ binaryPath: explicitBin, isFound: true, source: 'configured-path' });

    expect(
      resolveCorexBinary('~/bin/corex', {
        env: {},
        homeDir,
        platform: 'linux',
        statFn,
        workspaceDirs: [],
      })
    ).toEqual({ binaryPath: homeBin, isFound: true, source: 'configured-path' });

    expect(
      resolveCorexBinary(`${WORKSPACE_FOLDER_VAR}/tools/corex`, {
        env: {},
        homeDir,
        platform: 'linux',
        statFn,
        workspaceDirs: [workspaceDir],
      })
    ).toEqual({ binaryPath: workspaceToolBin, isFound: true, source: 'configured-path' });
  });

  it('resolves bare command names via PATH and auto-appends .exe on win32 configured paths', () => {
    const winToolsDir = path.resolve('/win-tools/bin');
    const winExplicitExe = path.resolve('/custom-sdk/corex.exe');
    const winBareCmdExe = path.resolve(winToolsDir, 'corex-custom.exe');
    const statFn = createVirtualStat({ [winBareCmdExe]: 'exec', [winExplicitExe]: 'exec' }, true);

    expect(
      resolveCorexBinary(path.resolve('/custom-sdk/corex'), {
        env: {},
        homeDir: path.resolve('/users/dev'),
        platform: 'win32',
        statFn,
        workspaceDirs: [],
      })
    ).toEqual({ binaryPath: winExplicitExe, isFound: true, source: 'configured-path' });

    expect(
      resolveCorexBinary('corex-custom', {
        env: { PATH: winToolsDir },
        homeDir: path.resolve('/users/dev'),
        platform: 'win32',
        statFn,
        workspaceDirs: [],
      })
    ).toEqual({ binaryPath: winBareCmdExe, isFound: true, source: 'configured-path' });
  });

  it('fails closed with configured-path-not-found (never falling back to workspace or PATH) when missing or a directory', () => {
    const workspaceDir = path.resolve('/virt-work/proj');
    const pathDir = path.resolve('/usr/local/bin');
    const existingDirTarget = path.resolve('/opt/corex-dir');
    const statFn = createVirtualStat({
      [existingDirTarget]: 'dir',
      [path.resolve(pathDir, 'corex')]: 'exec',
      [path.resolve(workspaceDir, 'build/stage0/corex')]: 'exec',
    });

    const missingResult = resolveCorexBinary('/opt/missing/corex', {
      env: { PATH: pathDir },
      homeDir: path.resolve('/home/dev'),
      platform: 'linux',
      statFn,
      workspaceDirs: [workspaceDir],
    });
    expect(missingResult).toEqual({
      binaryPath: null,
      configuredCandidate: path.resolve('/opt/missing/corex'),
      isFound: false,
      reason: 'configured-path-not-found',
    });

    const dirTargetResult = resolveCorexBinary(existingDirTarget, {
      env: { PATH: pathDir },
      homeDir: path.resolve('/home/dev'),
      platform: 'linux',
      statFn,
      workspaceDirs: [workspaceDir],
    });
    expect(dirTargetResult).toEqual({
      binaryPath: null,
      configuredCandidate: existingDirTarget,
      isFound: false,
      reason: 'configured-path-not-found',
    });

    const unexpandedWsResult = resolveCorexBinary(`${WORKSPACE_FOLDER_VAR}/bin/corex`, {
      env: { PATH: pathDir },
      homeDir: path.resolve('/home/dev'),
      platform: 'linux',
      statFn,
      workspaceDirs: [],
    });
    expect(unexpandedWsResult.isFound).toBe(false);
    if (!unexpandedWsResult.isFound) {
      expect(unexpandedWsResult.reason).toBe('configured-path-not-found');
    }

    const noHomeTildeResult = resolveCorexBinary('~/bin/corex', {
      env: { PATH: pathDir },
      homeDir: '',
      platform: 'linux',
      statFn,
      workspaceDirs: [workspaceDir],
    });
    expect(noHomeTildeResult.isFound).toBe(false);
    if (!noHomeTildeResult.isFound) {
      expect(noHomeTildeResult.reason).toBe('configured-path-not-found');
    }

    const relativeWithoutWs = resolveCorexBinary('./tools/corex', {
      env: { PATH: pathDir },
      homeDir: path.resolve('/home/dev'),
      platform: 'linux',
      statFn,
      workspaceDirs: [],
    });
    expect(relativeWithoutWs.isFound).toBe(false);
    if (!relativeWithoutWs.isFound) {
      expect(relativeWithoutWs.reason).toBe('configured-path-not-found');
    }
  });
});

// --------- Tier 2 & 3: Workspace & Sibling Discovery ----------

describe('Tier 2 & Tier 3 – Workspace build outputs, ancestor hop cap, and sibling ../corex', () => {
  it('enforces priority order: build/stage0 before zig-out/bin before build', () => {
    const workspaceDir = path.resolve('/virt-work/corex');
    const stage0Bin = path.resolve(workspaceDir, 'build/stage0/corex');
    const zigOutBin = path.resolve(workspaceDir, 'zig-out/bin/corex');
    const releaseBuildBin = path.resolve(workspaceDir, 'build/corex');

    const allThreeStat = createVirtualStat({
      [releaseBuildBin]: 'exec',
      [stage0Bin]: 'exec',
      [zigOutBin]: 'exec',
    });
    expect(
      resolveCorexBinary('', {
        env: {},
        homeDir: path.resolve('/no-home'),
        platform: 'linux',
        statFn: allThreeStat,
        workspaceDirs: [workspaceDir],
      })
    ).toEqual({ binaryPath: stage0Bin, isFound: true, source: 'workspace-build' });

    expect(
      resolveCorexBinary('', {
        env: {},
        homeDir: path.resolve('/no-home'),
        platform: 'linux',
        statFn: createVirtualStat({ [releaseBuildBin]: 'exec', [zigOutBin]: 'exec' }),
        workspaceDirs: [workspaceDir],
      })
    ).toEqual({ binaryPath: zigOutBin, isFound: true, source: 'workspace-build' });

    expect(
      resolveCorexBinary('', {
        env: {},
        homeDir: path.resolve('/no-home'),
        platform: 'linux',
        statFn: createVirtualStat({ [releaseBuildBin]: 'exec' }),
        workspaceDirs: [workspaceDir],
      })
    ).toEqual({ binaryPath: releaseBuildBin, isFound: true, source: 'workspace-build' });
  });

  it('walks upward up to MAX_ANCESTOR_HOPS (32) and stops beyond 32 hops', () => {
    expect(MAX_ANCESTOR_HOPS).toBe(32);
    const repoRoot = path.resolve('/ancestor-root');
    const rootBinary = path.resolve(repoRoot, 'build/stage0/corex');
    const statFn = createVirtualStat({ [rootBinary]: 'exec' });

    expect(
      resolveCorexBinary('', {
        env: {},
        homeDir: path.resolve('/no-home'),
        platform: 'linux',
        statFn,
        workspaceDirs: [buildNestedDir(repoRoot, MAX_ANCESTOR_HOPS)],
      })
    ).toEqual({ binaryPath: rootBinary, isFound: true, source: 'workspace-build' });

    expect(
      resolveCorexBinary('', {
        env: {},
        homeDir: path.resolve('/no-home'),
        platform: 'linux',
        statFn,
        workspaceDirs: [buildNestedDir(repoRoot, MAX_ANCESTOR_HOPS + 1)],
      })
    ).toEqual({ binaryPath: null, isFound: false, reason: 'not-found' });
  });

  it('resolves ../corex/build/stage0/corex[.exe] via Tier 3 both hermetically and against live ../corex', () => {
    const siblingBinary = path.resolve('/virt-repos/corex/build/stage0/corex');

    expect(
      resolveCorexBinary('', {
        env: {},
        homeDir: path.resolve('/no-home'),
        platform: 'linux',
        statFn: createVirtualStat({ [siblingBinary]: 'exec' }),
        workspaceDirs: [path.resolve('/virt-repos/vscode-ext-corex')],
      })
    ).toEqual({ binaryPath: siblingBinary, isFound: true, source: 'sibling-corex' });

    const liveResolution = resolveCorexBinary('', {
      env: {},
      homeDir: path.resolve('/non-existent-home'),
      workspaceDirs: [EXT_REPO_ROOT],
    });
    expect(liveResolution).toEqual({
      binaryPath: LIVE_STAGE0_BINARY,
      isFound: true,
      source: 'sibling-corex',
    });
  });
});

// -------------- Tier 4 & 5: Homes & PATH Lookup ---------------

describe('Tier 4 & Tier 5 – COREX_HOME, ~/.corex/bin, PATHEXT, and POSIX 0o111 permissions', () => {
  it('prioritizes $COREX_HOME/bin over ~/.corex/bin and ~/.corex/bin over PATH', () => {
    const corexHome = path.resolve('/custom/corex-home');
    const userHome = path.resolve('/home/developer');
    const pathDir = path.resolve('/usr/bin');

    const corexHomeBin = path.resolve(corexHome, 'bin/corex');
    const userHomeBin = path.resolve(userHome, '.corex/bin/corex');
    const systemPathBin = path.resolve(pathDir, 'corex');

    const allHomeStat = createVirtualStat({
      [corexHomeBin]: 'exec',
      [systemPathBin]: 'exec',
      [userHomeBin]: 'exec',
    });
    expect(
      resolveCorexBinary('', {
        env: { COREX_HOME: `"${corexHome}"`, PATH: pathDir },
        homeDir: userHome,
        platform: 'linux',
        statFn: allHomeStat,
        workspaceDirs: [],
      })
    ).toEqual({ binaryPath: corexHomeBin, isFound: true, source: 'corex-home' });

    expect(
      resolveCorexBinary('', {
        env: { PATH: pathDir },
        homeDir: userHome,
        platform: 'linux',
        statFn: createVirtualStat({ [systemPathBin]: 'exec', [userHomeBin]: 'exec' }),
        workspaceDirs: [],
      })
    ).toEqual({ binaryPath: userHomeBin, isFound: true, source: 'user-home' });
  });

  it('skips Windows .cmd/.bat shims under shell:false and resolves native .exe/.com across mixed-case Path', () => {
    const shimDir = path.resolve('/Program Files/Shims');
    const winBinDir = path.resolve('/Program Files/CoreX/bin');
    const cmdShim = path.resolve(shimDir, 'corex.cmd');
    const batShim = path.resolve(shimDir, 'corex.bat');
    const nativeCom = path.resolve(winBinDir, 'corex.com');

    expect(
      resolveCorexBinary('', {
        env: { PATHEXT: '.CMD;.BAT;.COM;.EXE', Path: `;"${shimDir}";"${winBinDir}";` },
        homeDir: path.resolve('/Users/nobody'),
        platform: 'win32',
        statFn: createVirtualStat(
          { [batShim]: 'exec', [cmdShim]: 'exec', [nativeCom]: 'exec' },
          true
        ),
        workspaceDirs: [],
      })
    ).toEqual({ binaryPath: nativeCom, isFound: true, source: 'path' });

    expect(
      resolveCorexBinary(cmdShim, {
        homeDir: path.resolve('/Users/nobody'),
        platform: 'win32',
        statFn: createVirtualStat({ [cmdShim]: 'exec' }, true),
        workspaceDirs: [],
      }).isFound
    ).toBe(false);
  });

  it('skips non-executable 0o644 files and 0o755 directories on POSIX PATH and returns not-found when exhausted', () => {
    const firstDir = path.resolve('/first-bin');
    const secondDir = path.resolve('/second-bin');
    const thirdDir = path.resolve('/third-bin');

    const nonExecFile = path.resolve(firstDir, 'corex');
    const directoryCollision = path.resolve(secondDir, 'corex');
    const realExecutable = path.resolve(thirdDir, 'corex');

    const statFn = createVirtualStat({
      [directoryCollision]: 'dir',
      [nonExecFile]: 'file644',
      [realExecutable]: 'exec',
    });

    expect(
      resolveCorexBinary('', {
        env: { PATH: `${firstDir}:${secondDir}:${thirdDir}` },
        homeDir: path.resolve('/empty-home'),
        platform: 'linux',
        statFn,
        workspaceDirs: [],
      })
    ).toEqual({ binaryPath: realExecutable, isFound: true, source: 'path' });

    expect(
      resolveCorexBinary('', {
        env: { PATH: `${firstDir}:${secondDir}` },
        homeDir: path.resolve('/empty-home'),
        platform: 'linux',
        statFn: createVirtualStat({ [directoryCollision]: 'dir', [nonExecFile]: 'file644' }),
        workspaceDirs: [],
      })
    ).toEqual({ binaryPath: null, isFound: false, reason: 'not-found' });
  });
});

// -------------- Toolchain Root & --internal-core --------------

describe('isCorexToolchainRoot and isInternalCoreEnabled', () => {
  it('identifies valid CoreX toolchain roots (core/root.cx + stage0/ or compiler/)', () => {
    const stage0Repo = path.resolve('/repos/corex-stage0');
    const selfHostedRepo = path.resolve('/repos/corex-selfhosted');
    const incompleteRepo = path.resolve('/repos/incomplete');

    const statFn = createVirtualStat({
      [path.resolve(incompleteRepo, 'core/root.cx')]: 'exec',
      [path.resolve(selfHostedRepo, 'compiler')]: 'dir',
      [path.resolve(selfHostedRepo, 'core/root.cx')]: 'file644',
      [path.resolve(stage0Repo, 'core/root.cx')]: 'file644',
      [path.resolve(stage0Repo, 'stage0')]: 'dir',
    });

    expect(isCorexToolchainRoot(stage0Repo, statFn)).toBe(true);
    expect(isCorexToolchainRoot(selfHostedRepo, statFn)).toBe(true);
    expect(isCorexToolchainRoot(incompleteRepo, statFn)).toBe(false);

    expect(isCorexToolchainRoot(COREX_REPO_ROOT)).toBe(true);
    expect(isCorexToolchainRoot(EXT_REPO_ROOT)).toBe(false);
  });

  it('evaluates always, never, and auto across workspace folders and single-file core/mem.cx mode', () => {
    expect(isInternalCoreEnabled('always', [EXT_REPO_ROOT])).toBe(true);
    expect(isInternalCoreEnabled('always', [])).toBe(true);
    expect(isInternalCoreEnabled('never', [COREX_REPO_ROOT])).toBe(false);

    expect(isInternalCoreEnabled('auto', [COREX_REPO_ROOT])).toBe(true);
    expect(isInternalCoreEnabled('auto', [path.resolve(COREX_REPO_ROOT, 'core', 'sys')])).toBe(
      true
    );
    expect(isInternalCoreEnabled('auto', [EXT_REPO_ROOT])).toBe(false);

    expect(
      isInternalCoreEnabled('auto', [], [path.resolve(COREX_REPO_ROOT, 'core', 'mem.cx')])
    ).toBe(true);
    expect(isInternalCoreEnabled('auto', [], [path.resolve(EXT_REPO_ROOT, 'package.json')])).toBe(
      false
    );
  });
});

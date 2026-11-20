/**
 * Bundler – Compiles `src/extension.ts` into the CommonJS extension bundle at `dist/extension.js`.
 *
 * Supports single-shot development builds (`node esbuild.js`), incremental watch mode (`--watch`),
 * and minified production builds (`--production`) used by `pnpm run check` and `vscode:prepublish`.
 *
 * Production builds enforce the strict `< 25 KB` (`25,600` bytes) zero-dependency bundle budget.
 */

const fs = require('node:fs');
const esbuild = require('esbuild');

// --------------------------------------- CONSTS ----------------------------------------

/** Entry-point TypeScript module for the VS Code extension host. */
const ENTRY_POINT = 'src/extension.ts';

/** Bundled CommonJS output path loaded by VS Code (`package.json` `main`). */
const OUTFILE = 'dist/extension.js';

/** Maximum permitted minified production bundle size (bytes; 25 KiB). */
const MAX_PROD_BUNDLE_SIZE = 25 * 1024;

/** CLI flags passed to the bundler process. */
const CLI_ARGS = new Set(process.argv.slice(2));

/** Whether the bundler is running in minified production mode (`--production`). */
const isProduction = CLI_ARGS.has('--production');

/** Whether the bundler is running in incremental watch mode (`--watch`). */
const isWatch = CLI_ARGS.has('--watch');

// ---------------------------------------- MAIN -----------------------------------------

/**
 * Bundles `src/extension.ts` into `dist/extension.js` and verifies the `< 25 KB` production cap.
 */
async function main() {
  const context = await esbuild.context({
    bundle: true,
    entryPoints: [ENTRY_POINT],
    external: ['vscode'],
    format: 'cjs',
    logLevel: 'info',
    minify: isProduction,
    outfile: OUTFILE,
    platform: 'node',
    sourcemap: !isProduction,
    sourcesContent: false,
    target: 'node20',
  });

  if (isWatch) {
    await context.watch();
    console.log('Watching for changes…');
    return;
  }

  await context.rebuild();
  await context.dispose();

  if (isProduction) {
    fs.rmSync(`${OUTFILE}.map`, { force: true });
    const bundleSize = fs.statSync(OUTFILE).size;
    if (bundleSize >= MAX_PROD_BUNDLE_SIZE) {
      throw new Error(
        `✗ Production bundle ${OUTFILE} is ${bundleSize} bytes (must be < ${MAX_PROD_BUNDLE_SIZE} bytes / 25 KB).`
      );
    }
    console.log(`✓ Production bundle ${OUTFILE}: ${bundleSize} bytes (< 25 KB budget).`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

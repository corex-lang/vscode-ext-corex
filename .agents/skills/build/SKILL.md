---
name: build
description: Validates, bundles, packages (.vsix), and locally installs the CoreX VS Code extension for dogfooding.
---

# Build

Use this skill to verify, bundle, package (`corex-1.0.0.vsix`), and locally install the CoreX extension (`corex-lang.corex`) in VS Code and OpenVSX-compatible editors during `Phase 10.5`–`12.8` dogfooding.

## 1. Pre-Packaging Validation

Before packaging, run the full repository verification pipeline and Markdown linter (see `.agents/AGENTS.md` Section 4):

```bash
pnpm run check
pnpm dlx markdownlint-cli2 "**/*.md" "!node_modules/**"
```

Resolve every error, warning, and lint diagnostic before proceeding.

## 2. Production Bundle & Size Gate

`pnpm run compile:prod` (executed automatically by both `pnpm run check` and `vscode:prepublish`) bundles `src/extension.ts` into minified CommonJS at `dist/extension.js` (`external: ['vscode']`) and asserts that `dist/extension.js` is strictly `< 25 KB` (`25,600` bytes; see `.agents/AGENTS.md` Section 3):

```bash
pnpm run compile:prod
```

## 3. Package `.vsix`

Package the extension into `corex-1.0.0.vsix` using `@vscode/vsce` with `--no-dependencies` (enforcing the zero-runtime-dependency contract):

```bash
pnpm dlx @vscode/vsce package --no-dependencies
```

Inspect the packaged archive contents if `.vscodeignore` or manifest contributions changed:

```bash
pnpm dlx @vscode/vsce ls
```

## 4. Install Locally & Dogfooding Gate

Uninstall any previous local build and install the freshly packaged `corex-1.0.0.vsix`:

```bash
code --uninstall-extension corex-lang.corex; code --install-extension corex-1.0.0.vsix
```

Then **reload the editor window** (`Ctrl+Shift+P` -> `Developer: Reload Window`) to activate the updated grammar and `corex lsp` client. During rapid iteration on `src/`, run `pnpm run watch` and launch the Extension Development Host (`F5`) instead of repackaging on every edit.

-   **Clean Up Temporary Archive:** Remove `corex-1.0.0.vsix` from the working tree once local installation is verified (`rm -f corex-*.vsix`).
-   **Pre-`v0.0.1` Local-Only Gate (CRITICAL):** Per `.agents/AGENTS.md` Section 4, **never** run `vsce publish` or `ovsx publish` before `CoreX v0.0.1` ships (`corex-lang/corex` `docs/LAUNCH.md` Stage `L1`).

## 5. Full One-Liner

For a complete validate -> lint docs -> package -> local reinstall cycle:

```bash
pnpm run check && pnpm dlx markdownlint-cli2 "**/*.md" "!node_modules/**" && pnpm dlx @vscode/vsce package --no-dependencies && code --uninstall-extension corex-lang.corex; code --install-extension corex-1.0.0.vsix
```

# Agent Guidelines for `vscode-ext-corex`

When working on this repository (`corex-lang/vscode-ext-corex`), any AI agent, subagent, or automated assistant must adhere strictly to the following rules to maintain the official CoreX VS Code & OpenVSX extension (`corex-lang.corex`) at maximum integrity, performance, and correctness.

## 1. Package Manager

This project uses **pnpm** exclusively. Always run commands through `pnpm` (e.g., `pnpm i`, `pnpm run <script>`, `pnpm exec <tool>`, `pnpm dlx <tool>`). **Never** use `npm`, `npx`, or `yarn`.

## 2. Strict Static Typing & Zero Unchecked Escape Hatches

Every line of TypeScript across `src/` and `test/` must be strictly typed and 100% statically analyzable (`strict: true`, `noUncheckedIndexedAccess: true`).

-   **Zero `any`:** Never use `any` (`typescript/no-explicit-any: "error"`). Type all untrusted inputs – JSON-RPC 2.0 payloads, workspace settings, child-process output, and caught exceptions – as `unknown` and narrow them explicitly with pure type-guard functions.
-   **No Blanket Suppressors (`@ts-ignore` Forbidden):** `@ts-ignore` and blanket file-wide linter suppressions in `src/` are strictly forbidden. When a static check suppression is fundamentally unavoidable, use `@ts-expect-error: <specific architectural reason>` or a single-rule scoped pragma (`// oxlint-disable-next-line <rule> -- <specific architectural reason>`), and only when rewriting the code to satisfy the check statically would degrade runtime performance or reduce readability.
-   **Separate Type Imports (`verbatimModuleSyntax: true`):** Import types exclusively via standalone `import type { … }` declarations (`typescript/consistent-type-imports`) – never mix value imports and inline `type` specifiers in the same statement.
-   **Interfaces & Erasable Syntax (`erasableSyntaxOnly: true`):** Use `interface` for object shapes (`typescript/consistent-type-definitions: ["error", "interface"]`) and discriminated union/literal types for sum types. Never use non-erasable TypeScript runtime constructs (`enum`, `namespace`, or parameter properties).

## 3. Performance, Bounded Resources & Zero Runtime Dependencies

This extension runs inside the user's editor host on startup, every keystroke, and every save. Cold-start activation latency, memory footprint, and per-message throughput are critical:

-   **Zero Runtime Dependencies (`0` `"dependencies"`):** `package.json` must declare **zero** runtime `"dependencies"`. Implement JSON-RPC 2.0 `Content-Length` framing, `corex lsp` client lifecycle management, executable resolution, and `corex fmt` fallback formatting directly on Node built-ins (`node:*`) and the `vscode` host API.
-   **Production Bundle Budget (`< 25 KB`):** The minified CommonJS bundle (`dist/extension.js`, produced by `node esbuild.js --production`) must remain strictly `< 25 KB` (`25,600` bytes, enforced automatically by `pnpm run compile:prod`).
-   **Lazy Initialization:** Avoid eager computation or process spawning at module load time. Defer `corex` binary discovery, output-channel creation, status-bar wiring, and `corex lsp` child-process startup until a `.cx` document or CoreX workspace requires them.
-   **Allocation & Loop Discipline:**
    -   **No Unnecessary Intermediate Arrays:** Prefer explicit `for` loops over chained `.map()/.filter()` closures when intermediate arrays are not needed. Write explicit loops with early `return` or `break` for short-circuiting checks.
    -   **No Loop String Concatenation:** Never use `+=` to build strings or byte buffers inside loops; accumulate slices/chunks and join once or write into pre-allocated `Buffer`s.
    -   **O(1) Membership Lookups (CRITICAL):** Always use `Set` or `Map` (`ReadonlySet` / `ReadonlyMap`) for membership checks and method dispatch – never linear array or tuple scans (`.includes()`, `.indexOf()`, `.find()`).
    -   **Non-Backtracking Regular Expressions:** Write deterministic, non-backtracking regular expressions in both TypeScript `RegExp` constants and `syntaxes/*.tmLanguage.json` Oniguruma rules using bounded character classes and explicit boundary lookaheads so adversarial lines never trigger catastrophic backtracking.
-   **Bounded Untrusted I/O & Workspace Trust:** Treat all `corex` child-process `stdout`/`stderr` bytes, workspace configuration values, and `.cx` source files as untrusted inputs:
    -   **Protocol & Memory Caps:** Enforce explicit upper bounds on JSON-RPC header blocks (`8 KiB`), single JSON-RPC message payloads (`16 MiB`), `stderr` diagnostic buffers, and in-flight pending-request / cache maps (evicting or rejecting on overflow rather than growing without bound).
    -   **Workspace Trust Gating:** Gate all external binary execution (`corex lsp` and `corex fmt`, especially workspace-local binaries and `corex.executablePath` overrides) behind `vscode.workspace.isTrusted`, degrading cleanly to static TextMate syntax highlighting in untrusted workspaces.

## 4. Validation, Testing, Changelog & Pre-`v0.0.1` Publishing Gate

After making any changes, validate them with the full check pipeline and Markdown linter:

```bash
pnpm run check
pnpm dlx markdownlint-cli2 "**/*.md" "!node_modules/**"
```

Fix every error, warning, and lint diagnostic until the output is completely clean (**zero errors, zero warnings, and zero lint issues**). Use the `test` skill (`.agents/skills/test/SKILL.md`) for test architecture and scope invariants, and the `build` skill (`.agents/skills/build/SKILL.md`) for `.vsix` packaging and local dogfooding installation.

-   **Regression Tests (CRITICAL):** Every bug fix **must** include a deterministic regression test in `test/` reproducing the original failure and verifying the fix before the task is considered complete.
-   **Keep `CHANGELOG.md` Updated (CRITICAL):** Document every user-visible change under the top/unreleased version section of `CHANGELOG.md` following [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) using canonical headings in order (`### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security` – include only non-empty sections). Never modify published release entries.
-   **Pre-`v0.0.1` Local-Only Gate (CRITICAL):** During CoreX `Phase 10.5`–`12.8`, package and install `vscode-ext-corex` **locally only** (`code --install-extension corex-1.0.0.vsix`) for dogfooding. **Strictly DO NOT publish** to the public Visual Studio Marketplace or OpenVSX (`vsce publish` and `ovsx publish` are forbidden) until after `CoreX v0.0.1` ships (`corex-lang/corex` `docs/LAUNCH.md` Stage `L1`).

## 5. Ask, Don't Assume

-   **Ask First:** If you encounter ambiguous requirements, UX trade-offs, TextMate scope ambiguities, or LSP protocol edge cases, **ask the user first**. Never guess or make silent assumptions.
-   **No Redundant Surfaces:** If multiple configuration settings, commands, or helper APIs could express the same behavior, ask the user for their preference before adding, altering, or removing public manifest entries.

## 6. UI, CLI & Typography Aesthetics

-   **Strict Ban on Colored Emojis (CRITICAL):** Never use colored emojis (such as `U+1F680`, `U+274C`, `U+2705`, `U+26A0 U+FE0F`) anywhere in extension UI strings, status-bar items, output-channel logs, test titles, source comments, commit messages, or Markdown documentation. Use built-in VS Code Codicons (`$(check)`, `$(error)`, `$(warning)`, `$(sync~spin)`) in editor UI surfaces and clean monochrome Unicode glyphs (`╭`, `│`, `╰`, `├`, `─`, `▸`, `•`, `✓`, `✗`, `⚠`) in logs, tests, and documentation.
-   **Typography & Punctuation:**
    -   Always use the single Unicode ellipsis character `…` (`U+2026`) instead of three ASCII dots `...` in all documentation, JSDoc, comments, and UI/log strings (except literal language syntax tokens).
    -   Never use em dashes (`U+2014`); use `; `, a new sentence, or an en dash (`–`).
    -   Always write `e.g.,` and `i.e.,` with a trailing comma.
-   **Markdown Linting:** All `.md` files must strictly satisfy `.markdownlint.json` (`-   ` 3-space unordered list markers, `1.  ` 2-space sequential ordered list markers, 4-space nested list indentation, fenced code blocks with language tags surrounded by blank lines, leading and trailing table pipes surrounded by blank lines, `*` emphasis/strong markers, and 1 blank line above and below headings).

## 7. Code Structure, Naming & Readability

-   **Plain Functions & Explicit Context (No Classes):** Write plain `function` declarations (`func-style: ["error", "declaration"]`) and module-level constants – never classes. Pass shared session or client state explicitly via typed `context` or `options` parameters.
-   **3-Part JSDoc Module Headers:** Start every `.ts` / `.js` / `.mts` file (except pure type-only barrels) with a 3-part JSDoc block:
    1.  **Title Line:** `Title – Concise Summary` (capitalized after the en dash `–`).
    2.  **Summary Paragraph:** A blank ` *` line followed by a concise 1–2 sentence description of the module's responsibility.
    3.  **Invariants (Optional):** A blank ` *` line followed by key resource bounds, Workspace Trust constraints, or lifecycle invariants.
-   **Section Dividers & Canonical Order:** Organize modules using exact **90-character** centered uppercase section dividers in canonical order (omitting unused sections): `TYPES`, `CONSTS`, `REGEX PATTERNS`, `INTERNALS`, `PUBLIC API`, `MAIN`.
    -   Pad the title with a single space on each side of the `-` fill characters, centering so `len(left) == len(right)` when even or `len(left) == len(right) - 1` when odd:

```typescript
// ---------------------------------------- TYPES ----------------------------------------
// --------------------------------------- CONSTS ----------------------------------------
// ----------------------------------- REGEX PATTERNS ------------------------------------
// -------------------------------------- INTERNALS --------------------------------------
// ------------------------------------- PUBLIC API --------------------------------------
// ---------------------------------------- MAIN -----------------------------------------
```

-   **Internal Sub-Section Dividers:** Use exact **65-character** centered dividers (excluding leading indentation, following the same `len(left) == len(right)` or `len(left) == len(right) - 1` parity rule) to group sub-sections inside large modules or test suites (e.g., `// ------------------------- Edge Cases -------------------------`).
-   **Define Before Use (`no-use-before-define`):** Place all imports at the top of the file, shared types in `src/types/` (and module-private types in `TYPES`), constants and static `Set`/`Map` tables in `CONSTS`, regexes in `REGEX PATTERNS`, internal helpers in `INTERNALS` *above* their callers, and exported entry points in `PUBLIC API`. Sort static lookup sets, maps, and configuration keys alphabetically unless priority order is required.
-   **Naming Conventions:**
    -   **Descriptive Multi-Letter Names (CRITICAL):** Single-letter variable and parameter names (e.g., `c`, `e`, `f`, `r`, `s`) are strictly banned. Use descriptive `camelCase` identifiers (`chunk`, `error`, `filePath`, `request`, `session`). The **only** exceptions are `i` and `j` for loop indices, `n` for mathematical counts/lengths, and `x`, `y`, `z` for spatial coordinates.
    -   **Booleans & Predicates:** Prefix boolean variables, interface properties, and predicate functions with `is` or `has` (`isTrusted`, `isRunning`, `hasPendingHeader`, `isValidBinary`).
    -   **Regular Expressions:** Name `RegExp` constants `<NAME>_RX` in `SCREAMING_SNAKE_CASE` inside `REGEX PATTERNS` and document each with `/** Matches … */` (omit the `u` flag unless Unicode code-point semantics are required).
    -   **Verb-First Actions & Path Resolution:** Start action and getter functions with an active verb (`parseFrameHeader`, `spawnServerProcess`, `formatDocument`, `readExtensionConfig`), and use canonical path helpers `resolvePath` and `resolveOrCreatePath`.
-   **Control Flow, Variables & Expression Hygiene:**
    -   Initialize `let` variables that may remain unset explicitly with `undefined` (`let timer: NodeJS.Timeout | undefined = undefined;`).
    -   Always increment counters with `i += 1` (`no-plusplus: "error"` – never `i++` or `++i`).
    -   Use `else if` for mutually exclusive branches and `switch` when dispatching repeatedly on a discriminant.
    -   **No Single-Use Temporary Variables (CRITICAL):** Never assign an expression to a temporary variable read only once; inline it directly into its consumer unless inlining spans four or more lines, obscures a complex multi-branch calculation, or recomputes an invariant inside a loop.
-   **JSDoc & Inline Comments (`< 150` Columns):**
    -   Document every exported and internal function, constant, and interface (including every interface property) with JSDoc, keeping single-sentence JSDoc and inline comments on one line whenever `< 150` characters (wrapping cleanly before column 150).
    -   In multi-parameter JSDoc blocks, list `@param` tags in exact signature order and align descriptions **3 spaces** after the longest parameter name (`@param document   Text document to format.`).
    -   Document measurement units in JSDoc rather than the identifier name (e.g., `/** Graceful LSP shutdown timeout (ms). */ const SHUTDOWN_TIMEOUT = 2_000;`).
    -   Wrap identifiers, types, CLI flags, settings keys, and file paths in backticks inside comments. Preserve existing unrelated comments when editing.

## 8. Rule & Skill Authoring (Single Source of Truth)

To keep agent instructions clean, maintainable, and free of contradictions, adhere strictly to the Single Source of Truth (SSOT) principle:

-   **Define Once:** Every rule, standard, or workflow must live in exactly **one** canonical file:
    -   **`.agents/AGENTS.md`:** Repository-wide core policies (package manager, strict typing, zero-dependency performance and resource bounds, validation and local-only publishing gate, aesthetics/typography, and code style).
    -   **Skills (`.agents/skills/{build,test}/SKILL.md`):** Specialized operational workflows (`build` for bundle verification, `.vsix` packaging, and local dogfooding installation; `test` for `vitest` suite architecture, TextMate scope invariants, and headless `corex lsp` / `corex fmt` integration testing).
-   **Reference, Never Duplicate:** When a rule defined in one file applies in another, point directly to `.agents/AGENTS.md` or the respective skill rather than copying or re-explaining it.
-   **Synchronize References:** Whenever a canonical rule moves or changes, update all references pointing to it in the same edit.

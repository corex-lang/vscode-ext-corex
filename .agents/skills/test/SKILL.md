---
name: test
description: Guidelines, invariants, and commands for running and maintaining the CoreX VS Code extension vitest suite.
---

# Test

In accordance with `.agents/AGENTS.md` Section 4, use this skill to write, organize, run, and maintain automated tests for `vscode-ext-corex`.

## 1. Architecture

Tests run headlessly in Node via **vitest** (`vitest.config.mts`), mapping `@/*` to `src/*` and aliasing `vscode` to `test/__mocks__/vscode.ts` so every parser, framing, binary-discovery, configuration, TextMate grammar, and `corex lsp` / `corex fmt` client path is verified without launching a GUI Extension Host.

| File | Purpose |
| :--- | :--- |
| `test/grammar.test.ts` | `vscode-textmate` + `vscode-oniguruma` scope tests covering all `DR-22`–`DR-24` tokens/keywords/primitives, Markdown `cx` codeblock injection, `../corex/core/**/*.cx`, `../corex/stdlib/cx/**/*.cx`, and `../corex/docs/COMPARISONS.md` showcases. |
| `test/framing.test.ts` | JSON-RPC 2.0 `Content-Length` framing parser and serializer tests (chunk fragmentation, multi-byte UTF-8, `LF`/`CRLF` headers, `8 KiB` header cap, `16 MiB` payload cap, malformed header recovery). |
| `test/binary.test.ts` | `corex` executable discovery (`corex.executablePath`, workspace `build/stage0/corex(.exe)` and `build/corex(.exe)` auto-detection, `PATH` lookup, Workspace Trust gating, `--internal-core` detection). |
| `test/config.test.ts` | Typed configuration reader, default values, and hot-reload change detection across all `corex.*` settings. |
| `test/lspClient.test.ts` | Headless end-to-end `corex lsp` (`initialize`, `didOpen`, `didChange`, `diagnostics`, `hover`, `definition`, `formatting`, `shutdown`, crash backoff) and `corex fmt` CLI fallback integration tests across `LF` and `CRLF` documents. |
| `test/__mocks__/vscode.ts` | Strictly typed minimal mock of the `vscode` host API (`Uri`, `Position`, `Range`, `TextEdit`, `Diagnostic`, `EventEmitter`, `workspace`, `window`, `languages`, `commands`). |
| `vitest.config.mts` | Vitest configuration resolving `@/` and `vscode` aliases. |

## 2. Test Organization & Conventions

1.  **Feature-Scoped Suites:** Group related cases with `describe()` per module or grammar construct, and follow `.agents/AGENTS.md` Section 7 inside every test file (`3`-part JSDoc module header, 90-character `CONSTS` / `INTERNALS` / `MAIN` dividers, 65-character sub-section dividers, descriptive variable names, and `i += 1`).
2.  **Monochrome Markers Only:** Follow `.agents/AGENTS.md` Section 6 – never use colored emojis in test titles, assertions, or comments; use monochrome `✓` and `✗` when contrasting expected vs. anti-pattern examples:
    -   `✓` `it('tokenizes nested {expr=:#06x} interpolation holes inside multiline strings')`
    -   `✗` `it('test string')`
3.  **Positive & Negative Coverage:** Pair every positive assertion with negative and boundary assertions:
    -   `✓` Valid constructs produce exact scopes, framed payloads, resolved paths, and `TextEdit` ranges.
    -   `✗` False-positive identifier prefixes (`fn_name`, `own_value`, `u8_slice`), untrusted workspaces, oversized `Content-Length` frames (`> 8 KiB` headers or `> 16 MiB` payloads), and missing binaries are rejected or suppressed cleanly without unhandled rejections.
4.  **Deterministic Teardown:** Reset mock workspace state and await child-process termination in `afterEach` so zero `corex` processes, file handles, or timers leak across tests. Note `.oxlintrc.json` sets `"no-await-in-loop": "off"` for `test/**/*.ts` to support sequential LSP request-response turns.

## 3. TextMate Grammar Scope Invariants

Every non-whitespace token produced by `syntaxes/corex.tmLanguage.json` (and embedded `cx` blocks via `syntaxes/corex.markdown.tmLanguage.json`) across inline fixtures, `../corex/core/**/*.cx`, and `../corex/docs/COMPARISONS.md` must satisfy three strict invariants:

1.  **Non-Root Scope Depth:** `token.scopes.length > 1` – no non-whitespace token may fall through to bare `source.corex`.
2.  **Specific Innermost Lexical Scope:** The innermost scope (`token.scopes[token.scopes.length - 1]`) must never be a bare container scope (`source.*` or `meta.*`) – every keyword, identifier, literal, annotation, operator, docstring Markdown span, and delimiter inside a `meta.*` region must carry an explicit leaf scope (`keyword.*`, `storage.*`, `entity.*`, `constant.*`, `string.*`, `variable.*`, `support.*`, `comment.*`, `markup.*`, or `punctuation.*`).
3.  **Zero Unintended `invalid.*` Scopes:** Valid CoreX v1.0 code must emit zero `invalid.*` scopes; `invalid.illegal.*` is permitted strictly in dedicated negative-test snippets verifying malformed literal/escape highlighting.

## 4. Headless `corex lsp` & `corex fmt` Integration

Integration tests in `test/lspClient.test.ts` spawn the live Stage-0 compiler binary at `../corex/build/stage0/corex.exe` on Windows (`../corex/build/stage0/corex` on POSIX):

-   **LSP Lifecycle & Queries:** Verify `initialize` -> `initialized`, `--internal-core` workspace flag injection, `textDocument/publishDiagnostics` (or pull diagnostics), `textDocument/hover`, `textDocument/definition`, `textDocument/formatting`, and clean `shutdown` -> `exit` handshake.
-   **CLI Formatter Fallback:** Verify isolated temp-file `corex fmt` CLI fallback (`runCorexFmtCli`) when `corex.lsp.enable` is `false` and `corex.format.enable` is `true`.
-   **Line-Ending Parity (`LF` & `CRLF`):** Exercise both `\n` (`LF`) and `\r\n` (`CRLF`) document inputs across framing, UTF-16 `Position` / `Range` conversion, diagnostics, and full-document formatting edits.

## 5. Running Tests

### Single Headless Run

```bash
pnpm run test
```

### Watch Mode

```bash
pnpm run test:watch
```

### Full Check Pipeline

```bash
pnpm run check
```

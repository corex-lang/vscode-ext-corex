# Changelog

All notable changes to the **CoreX** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<br>

## [Unreleased]

### Added

-   Initial release of the official **CoreX** (`corex-lang.corex`) language extension for VS Code and OpenVSX-compatible editors.
-   Complete CoreX v1.0 TextMate grammar (`syntaxes/corex.tmLanguage.json`, `source.corex`) covering all 121 `TokenKind`s, 50 language keywords, 20 built-in primitive types (including `opaque`), 11 contextual modifiers, 13 Constrained Type Groups, prelude traits/types, all 13 canonical C FFI scalar aliases, `#!` shebangs, TOML `---` script frontmatter, `#soa` directives, `@attribute` / `@intrinsic` annotations (`@repr`, `@link`), `:label` / `label:` loop and `match` FSM labels, `/#` module and `/|` item docstrings (flagging retired `/* … */`, `//!`, and `///` comments), and `//` line comments.
-   Full literal and string-interpolation highlighting across single-line `"…"` (with operator-red `{placeholder}` template spans), indent-stripped multiline `"<newline> … "`, interpolated `f"…"` / `f#"…"#`, raw `r#"…"#`, byte `b'x'` / `b"…"` / `br#"…"#` literals, `{{` / `}}` brace escapes in `f`-strings, `_`-separated numeric suffixes (`_u32`, `_f32`, …), and recursive `{expr:spec}` / `{expr=:#06x}` format specifiers (flagging retired `"""` delimiters).
-   Markdown fenced code-block injection grammar (`syntaxes/corex.markdown.tmLanguage.json`) highlighting ```` ```cx ```` and ```` ```corex ```` blocks in Markdown previews, documentation, and LSP hover cards.
-   Rich `language-configuration.json` with `/#` and `/|` docstring continuation, smart block, `match` arm, and multiline `"<newline> … "` string indentation, auto-closing pairs, bracket pair colorization, and `#region` / `#endregion` folding markers.
-   Zero-runtime-dependency `corex lsp` JSON-RPC 2.0 `stdio` client (`< 25 KB` minified bundle) providing sub-10 ms diagnostics, SAST memory/bounds/contract verification feedback, hover documentation, go-to-definition, find-references, workspace symbols, signature help, inlay hints, code actions, `1px` multiline string strip-margin guides, and `0.58` opacity dimming on pure `_ = ident;` discards and `_`-prefixed unused bindings.
-   Seamless `corex fmt` document and range formatting via `corex lsp` with automatic isolated temp-file `corex fmt` CLI fallback when `corex lsp` is disabled or unavailable.
-   Five custom semantic token modifiers (`mutable`, `consumedMove`, `unsafe`, `attribute`, `linearResource`) and flicker-free `semanticTokenScopes` fallbacks tuned for both **Isolux Theme** and GitHub PrettyLights.
-   Automatic `corex` binary discovery across `corex.executablePath`, workspace compiler builds (`build/stage0/corex`, `zig-out/bin/corex`, `build/corex`, and sibling `../corex/build/…`), `$COREX_HOME/bin/corex`, `~/.corex/bin/corex`, and `PATH`, with `--internal-core` auto-detection and strict Workspace Trust gating.
-   Interactive Oxc-style dual-service status bar (`CoreX: Show Status Bar Menu`, `CoreX: Stop Language Server`, and `CoreX: Toggle Inlay Hints`) displaying live `corex lsp` and `corex fmt` status, trusted Markdown action links on hover, and a one-click QuickPick management menu.
-   Non-backtracking Markdown syntax scopes inside `/#` and `/|` documentation comments (inline `` `code` ``, fenced blocks, headings, bold/italic emphasis, `[title](url)` links, and backslash escapes).
-   Dedicated non-backtracking TextMate highlighting for `@expect(…)` and `@allow(…)` lint suppression attributes (`W0xxx` warning codes, `kebab-case` rule slugs, and `reason:` strings) alongside `// corex check:` (`file-expect`, `file-allow`, `expect`, `allow`) and `// corex fmt:` (`file-off`, `off`, `on`) comment directives and `-- <reason>` rationales.
-   `CoreX: Fix All Safe Issues` (`corex.fixAll`), `CoreX: Toggle Formatter` (`corex.toggleFormat`), and one-click `Open Project Config` (`corex.toml` discovery) actions in the Command Palette and `CoreX` status-bar QuickPick menu.
-   Backtick (`` `…` ``) selection surrounding across code, strings, and comments, plus embedded `corex-comment` Markdown emphasis/strikethrough (`*…*`, `_…_`, `~…~`) selection surrounding strictly inside `//`, `/|`, and `/#` comments and docstrings (`language-comment-configuration.json`).

### Changed

-   Scoped `let` and `(x := expr)` local bindings as `variable.other.readwrite.corex` so immutable local variables render with standard variable foreground colors while `const` items retain constant styling.
-   Styled `corex lsp` function contract/stack hover footers, status-bar version subtitles, and faulted service rows exclusively with native VS Code CSS theme variables (`var(--vscode-descriptionForeground)`, `var(--vscode-editorError-foreground)`, and `var(--vscode-editorWarning-foreground)`, omitting color overrides in High Contrast themes).
-   Streamlined the `CoreX` status-bar indicator (`$(check-all)` / `$(check)` / `$(circle-slash)` active-service icons with fault-only `warning`/`error` backgrounds), hover popover (inline `Restart · Stop` / `Start` and `Disable` / `Enable` service controls), and usage-ordered QuickPick menu (dynamically promoting `Troubleshooting` actions on faults), while reading `SemanticTokensLegend` dynamically from `corex lsp` capabilities (`< 25 KB` production bundle).
-   Switched multiline string strip-margin guides to a subtle `dotted` `1px` border (`editorIndentGuide.background1`) rendered only across blocks that preserve leading spaces past closing-quote column `C`.
-   Unified `f`, `b`, `r`, and `br` string/byte/char literal prefixes onto operator-red (`keyword.operator.prefix.string.corex`) and `'…'` character quote scopes onto `punctuation.definition.string.{begin,end}.corex`.

### Fixed

-   Enabled built-in `'log'` syntax highlighting on the `CoreX` VS Code Output channel (`window.createOutputChannel('CoreX', 'log')`).
-   Mapped plain `namespace` (`["support.module.corex", "entity.name.namespace.corex"]`) and `enumMember.attribute` (`["support.constant.lint-rule.corex", "variable.other.enummember.corex"]`) in `semanticTokenScopes` so all module names and `@expect`/`@allow` lint rule slugs retain consistent highlighting once `corex lsp` semantic tokens arrive.
-   Removed inert string-literal escape highlighting (`\n`, `\t`, `\r`, `\0`, `\x..`, `\u{..}`) inside comments and backtick spans while highlighting CommonMark trailing `\` hard line breaks (`constant.character.escape.markdown.corex`) at the end of `/|` and `/#` docstring lines.

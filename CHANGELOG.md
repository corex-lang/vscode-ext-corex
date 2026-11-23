# Changelog

All notable changes to the **CoreX** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<br>

## [Unreleased]

### Added

-   Initial release of the official **CoreX** (`corex-lang.corex`) language extension for VS Code and OpenVSX-compatible editors.
-   Complete CoreX v1.0 TextMate grammar (`syntaxes/corex.tmLanguage.json`, `source.corex`) covering all 120 `TokenKind`s, 50 language keywords, 20 built-in primitive types (including `opaque`), 11 contextual modifiers, 13 Constrained Type Groups, prelude traits/types, all 13 canonical C FFI scalar aliases, `#!` shebangs, TOML `---` script frontmatter, `#soa` directives, `@attribute` / `@intrinsic` annotations, `:label` / `label:` loop and `match` FSM labels, `///` / `//!` line doc comments (flagging banned `/** … */` / `/*! … */` block doc comments), and nested `/* … */` block comments.
-   Full literal and string-interpolation highlighting across single-line `"…"`, indent-stripped multiline `"""…"""`, raw `r#"…"#` / `r#"""…"""#`, byte `b'x'` / `b"…"` / `br#"…"#` literals, `{{` / `}}` brace escapes, `_`-separated numeric suffixes (`_u32`, `_f32`, …), and recursive `{expr:spec}` / `{expr=:#06x}` format specifiers.
-   Markdown fenced code-block injection grammar (`syntaxes/corex.markdown.tmLanguage.json`) highlighting ```` ```cx ```` and ```` ```corex ```` blocks in Markdown previews, documentation, and LSP hover cards.
-   Rich `language-configuration.json` with `///`, `//!`, and nested `/* … */` comment continuation, smart block and `match` arm indentation, auto-closing pairs (including `"""…"""`), bracket pair colorization, and `#region` / `#endregion` folding markers.
-   Zero-runtime-dependency `corex lsp` JSON-RPC 2.0 `stdio` client (`< 25 KB` minified bundle) providing sub-10 ms diagnostics, SAST memory/bounds/contract verification feedback, hover documentation, go-to-definition, find-references, workspace symbols, signature help, inlay hints, and code actions.
-   Seamless `corex fmt` document and range formatting via `corex lsp` with automatic isolated temp-file `corex fmt` CLI fallback when `corex lsp` is disabled or unavailable.
-   Five custom semantic token modifiers (`mutable`, `consumedMove`, `unsafe`, `attribute`, `linearResource`) and flicker-free `semanticTokenScopes` fallbacks tuned for both **Isolux Theme** and GitHub PrettyLights.
-   Automatic `corex` binary discovery across `corex.executablePath`, workspace compiler builds (`build/stage0/corex`, `zig-out/bin/corex`, `build/corex`, and sibling `../corex/build/…`), `$COREX_HOME/bin/corex`, `~/.corex/bin/corex`, and `PATH`, with `--internal-core` auto-detection and strict Workspace Trust gating.
-   Interactive Oxc-style dual-service status bar (`CoreX: Show Status Bar Menu`, `CoreX: Stop Language Server`, and `CoreX: Toggle Inlay Hints`) displaying live `corex lsp` and `corex fmt` status, trusted Markdown action links on hover, and a one-click QuickPick management menu.
-   Non-backtracking Markdown syntax scopes inside `///` and `//!` documentation comments (inline `` `code` ``, fenced blocks, headings, bold/italic emphasis, `[title](url)` links, and backslash escapes).

### Changed

-   Scoped `let` and `(x := expr)` local bindings as `variable.other.readwrite.corex` so immutable local variables render with standard variable foreground colors while `const` items retain constant styling.

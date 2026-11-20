<div align="center">
  <br><br>
  <h1>
    <a href="https://github.com/corex-lang/vscode-ext-corex"><img height="96" src="https://raw.githubusercontent.com/corex-lang/vscode-ext-corex/main/assets/icon.png"></a>
    <br>
    CoreX
    <br><br>
    <a href="https://open-vsx.org/extension/corex-lang/corex"><img src="https://svg.xul.is/badge/ovsx/corex-lang/corex/v?color=indigo" /></a>
    <a href="https://open-vsx.org/extension/corex-lang/corex"><img src="https://svg.xul.is/badge/ovsx/corex-lang/corex/dt?color=indigo" /></a>
    <a href="https://github.com/corex-lang/vscode-ext-corex/blob/main/LICENSE"><img src="https://svg.xul.is/badge/License/MIT*?variant=3&color=neutral&icon=scale" /></a>
    <a href="https://github.com/corex-lang/vscode-ext-corex/commits"><img src="https://svg.xul.is/badge/gh/corex-lang/vscode-ext-corex/commit?variant=3&color=neutral" /></a>
    <a href="https://github.com/sponsors/xulbux"><img src="https://svg.xul.is/badge/Sponsor?variant=2&color=rose&icon=heart&anim=pulse" /></a>
  </h1>
  <h3>Official CoreX language support – syntax highlighting, semantic tokens, SAST diagnostics, and formatting.</h3>
  <br><br>
</div>

This VS Code extension provides complete language support for **CoreX** (`.cx`), pairing a full v1.0 TextMate grammar with a built-in client for `corex lsp` and `corex fmt`.<br>
It is engineered with **zero runtime dependencies and a `< 25 KB` production bundle**, keeping cold-start activation and keystroke latency instant.

> <br>
> &numsp;Explore the full capability breakdown under <a href="#features"><b>features</b></a> or customize behavior under <a href="#configuration"><b>configuration</b></a>.
> <br><br>

<br>
<br>

## <a href="#installation"><img src="https://svg.xul.is/icon/package?size=32&stroke=2" align="left" /></a>Installation

Search for **CoreX** in the VS Code extensions panel, or install via the command line:

```bash
ext install corex-lang.corex
```

When developing the CoreX compiler or standard library locally prior to public release, package and install the extension directly from source:

```bash
pnpm dlx @vscode/vsce package --no-dependencies
code --install-extension corex-1.0.0.vsix
```

For live diagnostics, navigation, semantic tokens, and formatting, ensure the `corex` toolchain binary is available via `corex.executablePath`, in workspace build outputs (`build/stage0/corex`, `zig-out/bin/corex`, `build/corex`, or sibling `../corex/build/…`), under `$COREX_HOME/bin/corex` or `~/.corex/bin/corex`, or on `PATH`.

<br>

## <a href="#features"><img src="https://svg.xul.is/icon/zap?size=32&stroke=2" align="left" /></a>Features

| Feature | Description |
| :------ | :---------- |
| **Complete v1.0 Grammar** | Full TextMate highlighting (`source.corex`) covering all 120 `TokenKind`s, 50 keywords, 20 primitives (`i8`–`u128`, `f32`, `f64`, `str`, `unit`, `never`, `opaque`), 11 contextual modifiers, and 12 Constrained Type Groups (`Number`, `Integer`, `Scalar`, `Bytes`, …). |
| **Rich Literal & Interpolation Scopes** | Highlights single-line `"…"`, indent-stripped multiline `"""…"""`, raw `r#"…"#` / `r#"""…"""#`, byte `b'x'` / `b"…"` / `br#"…"#` literals, `{{` / `}}` escapes, `_`-separated numeric suffixes (`0x4358_u32`, `0.5_f32`), and recursive `{expr=:#06x}` format interpolations. |
| **Markdown Code Blocks** | Injects CoreX syntax highlighting into fenced ```` ```cx ```` and ```` ```corex ```` blocks across Markdown files and hover documentation popups. |
| **Live `corex lsp` & SAST** | Streams sub-10 ms incremental type errors, MVS ownership and borrow diagnostics, Pentagon compile-time bounds proofs, `@linear` leak checks, and `@no_alloc` / `@no_panic` / `@max_stack` contract verification. |
| **Flicker-Free Semantic Tokens** | Aligns `corex lsp` semantic token classifications with TextMate scope fallbacks and registers 5 CoreX-specific semantic modifiers (`mutable`, `consumedMove`, `unsafe`, `attribute`, `linearResource`). |
| **Navigation, Hover & Inlay Hints** | Supports go-to-definition, find-references, workspace symbols, signature help, inferred capability/stack-budget hover cards, and `\|>` pipeline / inferred binding inlay hints. |
| **Canonical Formatting (`corex fmt`)** | Formats `.cx` documents and ranges losslessly via `corex lsp` (`textDocument/formatting` & `textDocument/rangeFormatting`), automatically falling back to standalone `corex fmt` CLI inside an isolated temporary directory when `corex lsp` is disabled or unavailable. |
| **Zero-Dependency & Workspace-Safe** | Ships with zero runtime dependencies (`< 25 KB` minified bundle), bounded JSON-RPC framing (`8 KiB` headers / `16 MiB` payloads), and strict Workspace Trust gating before executing local binaries. |

<br>

## <a href="#semantic-token-modifiers"><img src="https://svg.xul.is/icon/palette?size=32&stroke=2" align="left" /></a>Semantic Token Modifiers

CoreX extends VS Code's standard semantic token legend with five language-specific modifiers emitted by `corex lsp`, which themes and `editor.semanticTokenColorCustomizations` rules can target directly:

| Modifier | Description |
| :------- | :---------- |
| `mutable` | Mutable binding, parameter, or borrow (`var`, `mut`, `&mut`). |
| `consumedMove` | Value whose ownership is transferred via MVS move (`own` / `sink`). |
| `unsafe` | Unsafe or `extern` FFI declaration, block, or operation. |
| `attribute` | Compile-time `@attribute` annotation or intrinsic directive. |
| `linearResource` | Linear resource requiring explicit deterministic cleanup (`defer`). |

<br>

## <a href="#configuration"><img src="https://svg.xul.is/icon/settings?size=32&stroke=2" align="left" /></a>Configuration

Configure the CoreX extension in your user or workspace `settings.json`:

| Setting | Type | Default | Description |
| :------ | :--: | :-----: | :---------- |
| `corex.enable` | `boolean` | `true` | Enable the CoreX language extension (`corex lsp` and `corex fmt` integration). Static TextMate syntax highlighting remains active even when disabled. |
| `corex.lsp.enable` | `boolean` | `true` | Enable the built-in `corex lsp` language server for live diagnostics, semantic tokens, hover documentation, navigation, inlay hints, and code actions. |
| `corex.executablePath` | `string` | `""` | Explicit path to the `corex` compiler binary. When empty, searches workspace build outputs (`build/stage0/corex`, `zig-out/bin/corex`, `build/corex`, and sibling `../corex/build/…`), `$COREX_HOME/bin/corex`, `~/.corex/bin/corex`, and `PATH`. |
| `corex.internalCore` | `string` | `"auto"` | Control whether `--internal-core` is passed to `corex lsp` and `corex fmt`: `"auto"` (compiler/`core/`/`stdlib/cx/` workspaces), `"always"`, or `"never"`. |
| `corex.trace.server` | `string` | `"off"` | Trace JSON-RPC 2.0 traffic between VS Code and `corex lsp` in the **CoreX** Output channel: `"off"`, `"messages"`, or `"verbose"`. |
| `corex.format.enable` | `boolean` | `true` | Register CoreX document and range formatting (`corex fmt`), using `corex lsp` when active and falling back to standalone `corex fmt` CLI when `corex lsp` is disabled or unavailable. |
| `corex.inlayHints.enable` | `boolean` | `true` | Show `corex lsp` inlay hints for inferred binding types, `\|>` pipeline intermediate types, parameter names, and MVS ownership modes. |

<br>

## <a href="#commands"><img src="https://svg.xul.is/icon/terminal?size=32&stroke=2" align="left" /></a>Commands

Open the Command Palette (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> or <kbd>F1</kbd>) to run the built-in CoreX commands:

| Command | ID | Description |
| :------ | :- | :---------- |
| **CoreX: Restart Language Server** | `corex.restartServer` | Gracefully stops and restarts the active `corex lsp` process, reloading binary discovery and workspace settings. |
| **CoreX: Show Output Channel** | `corex.showOutputChannel` | Opens the **CoreX** Output panel displaying server lifecycle logs, diagnostics, and optional JSON-RPC traces. |

<br>

## <a href="#recommended-settings"><img src="https://svg.xul.is/icon/sliders-horizontal?size=32&stroke=2" align="left" /></a>Recommended Settings

For the sharpest CoreX editing experience, add the following options to your `settings.json` (paired seamlessly with [**Isolux Theme**](https://open-vsx.org/extension/xulbux/theme-isolux)):

```jsonc
{
  // Format .cx files canonically with corex fmt on save:
  "[corex]": {
    "editor.formatOnSave": true,
    "editor.insertSpaces": true,
    "editor.semanticHighlighting.enabled": true,
    "editor.tabSize": 4
  },
  // Enable colorization and active guides for (), [], and {} delimiters:
  "editor.bracketPairColorization.enabled": true,
  "editor.bracketPairColorization.independentColorPoolPerBracketType": true,
  "editor.guides.bracketPairs": "active"
}
```

<br>
<br>

## <a href="#troubleshooting"><img src="https://svg.xul.is/icon/bug?size=32&stroke=2" align="left" /></a>Troubleshooting

If live diagnostics, navigation, or formatting do not behave as expected, inspect the extension logs:

1.  Open the **Output** panel (menu **View → Output**, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd>, or run **CoreX: Show Output Channel**).

2.  Select **CoreX** from the channel dropdown in the top-right corner of the panel.

3.  Verify that Workspace Trust is granted – in untrusted or virtual workspaces, CoreX intentionally restricts external process execution (`corex lsp` and `corex fmt`) and runs in static syntax-highlighting mode only.

4.  For deep protocol debugging, set `"corex.trace.server": "messages"` (or `"verbose"`) in `settings.json` and run **CoreX: Restart Language Server**.

<br>
<br>
<br>

## Enjoying this extension?&numsp;Have suggestions?

Please consider giving a [![star](https://svg.xul.is/icon/star?size=20&anim=shake)](https://github.com/corex-lang/vscode-ext-corex) on [**GitHub**](https://github.com/corex-lang/vscode-ext-corex) or leaving a review on [**Open VSX**](https://open-vsx.org/extension/corex-lang/corex) or the [**Visual Studio Marketplace**](https://marketplace.visualstudio.com/items?itemName=corex-lang.corex).

<br>
<br>
<br>

---

[![sparkles](https://svg.xul.is/icon/sparkles?size=20)](https://xulbux.com) Always creating more cool stuff for you! [![sparkles](https://svg.xul.is/icon/sparkles?size=20)](https://xulbux.com)&emsp;–&numsp;[**XulbuX**](https://xulbux.com)

<div align="center">
  <br><br>
  <h1>
    <a href="https://github.com/corex-lang/vscode-ext-corex"><img height="96" src="https://raw.githubusercontent.com/corex-lang/vscode-ext-corex/main/assets/icon.png"></a>
    <br>
    CoreX for VS Code
    <br><br>
    <a href="https://open-vsx.org/extension/corex-lang/corex"><img src="https://svg.xul.is/badge/ovsx/corex-lang/corex/v?color=indigo" /></a>
    <a href="https://open-vsx.org/extension/corex-lang/corex"><img src="https://svg.xul.is/badge/ovsx/corex-lang/corex/dt?color=indigo" /></a>
    <a href="https://github.com/corex-lang/vscode-ext-corex/blob/main/LICENSE"><img src="https://svg.xul.is/badge/License/MIT*?variant=3&color=neutral&icon=scale" /></a>
    <a href="https://github.com/corex-lang/vscode-ext-corex/commits"><img src="https://svg.xul.is/badge/gh/corex-lang/vscode-ext-corex/commit?variant=3&color=neutral" /></a>
    <a href="https://github.com/sponsors/xulbux"><img src="https://svg.xul.is/badge/Sponsor?variant=2&color=rose&icon=heart&anim=pulse" /></a>
  </h1>
  <h3>Official CoreX language support with syntax highlighting, IntelliSense, diagnostics, and formatting.</h3>
  <br><br>
</div>

This VS Code extension brings complete [**CoreX**](https://github.com/corex-lang/corex) (`.cx`) language support to the editor, pairing rich syntax highlighting with live language intelligence.<br>
Syntax highlighting works out of the box, while installing the **`corex` toolchain** unlocks **instant diagnostics, code navigation, completions, and format-on-save**.

> <br>
> &numsp;Explore what is included under <a href="#features"><b>features</b></a> or tailor behavior under <a href="#configuration"><b>configuration</b></a>.
> <br><br>

<br>
<br>

## <a href="#installation"><img src="https://svg.xul.is/icon/package?size=32&stroke=2" align="left" /></a>Installation

Search for **CoreX** in the VS Code extensions panel, or install via the command line:

```bash
ext install corex-lang.corex
```

Syntax highlighting is active immediately. For live diagnostics, IntelliSense, navigation, and formatting, install the [**CoreX toolchain**](https://github.com/corex-lang/corex) so `corex` is available on your `PATH` (or set `corex.executablePath` in your settings).

<br>

## <a href="#features"><img src="https://svg.xul.is/icon/zap?size=32&stroke=2" align="left" /></a>Features

| Feature | Description |
| :------ | :---------- |
| **Syntax Highlighting** | Full highlighting for `.cx` files and scripts, covering types, ownership modifiers, `@attributes`, `f"…"` / `f#"…"#` string interpolations (`{val:#06x}`, `{expr=}`), `{placeholder}` template spans, raw and multiline `"<newline> … "` strings (with strip-margin guides), and `/#` / `/\|` docstrings. |
| **Markdown Code Blocks** | Highlights fenced ```` ```cx ```` and ```` ```corex ```` code blocks inside Markdown files, previews, and hover documentation. |
| **Live Diagnostics** | Instant type, borrow, ownership, bounds, and `@no_alloc` / `@no_panic` / `@max_stack` contract feedback with one-click quick fixes. |
| **IntelliSense & Navigation** | Auto-completion, signature help, go-to-definition, find-references, symbol search, safe cross-file rename, and rich hover cards. |
| **Inlay Hints** | Inline hints for inferred variable types, `\|>` pipeline stages, parameter names, and ownership modes. |
| **Semantic Highlighting** | Fine-grained semantic tokens with CoreX-specific modifiers (`mutable`, `consumedMove`, `unsafe`, `attribute`, `linearResource`) for theme customization. |
| **Code Formatting** | Lossless document and selection formatting powered by `corex fmt`, ready for format-on-save. |

<br>

## <a href="#semantic-token-modifiers"><img src="https://svg.xul.is/icon/palette?size=32&stroke=2" align="left" /></a>Semantic Token Modifiers

CoreX extends VS Code's standard semantic token set with five language-specific modifiers that themes and `editor.semanticTokenColorCustomizations` rules can target directly:

| Modifier | Description |
| :------- | :---------- |
| `mutable` | Mutable binding, parameter, or borrow (`var`, `mut`, `&mut`). |
| `consumedMove` | Value whose ownership is moved (`own`). |
| `unsafe` | `unsafe` or `extern` FFI declaration, block, or operation. |
| `attribute` | Compile-time `@attribute` annotation or intrinsic directive. |
| `linearResource` | Linear resource requiring explicit deterministic cleanup (`defer`). |

<br>

## <a href="#configuration"><img src="https://svg.xul.is/icon/settings?size=32&stroke=2" align="left" /></a>Configuration

You can customize the extension in your `settings.json` (user or workspace):

| Setting | Type | Default | Description |
| :------ | :--: | :-----: | :---------- |
| `corex.enable` | `boolean` | `true` | Enable language server and formatter integration. Static syntax highlighting stays active even when disabled. |
| `corex.lsp.enable` | `boolean` | `true` | Enable the language server for live diagnostics, semantic tokens, hover cards, navigation, inlay hints, and quick fixes. |
| `corex.executablePath` | `string` | `""` | Explicit path to the `corex` binary. Leave empty to discover `corex` automatically from `~/.corex/bin`, `PATH`, or workspace builds. |
| `corex.format.enable` | `boolean` | `true` | Enable CoreX document and selection formatting (`corex fmt`). |
| `corex.inlayHints.enable` | `boolean` | `false` | Show inline hints for inferred binding types and parameter names. |

(*For advanced options like language server trace logging, check the CoreX extension settings inside VS Code!*)

<br>

## <a href="#commands"><img src="https://svg.xul.is/icon/terminal?size=32&stroke=2" align="left" /></a>Commands

Open the Command Palette (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> or <kbd>F1</kbd>) to run the built-in CoreX commands:

| Command | ID | Description |
| :------ | :- | :---------- |
| **CoreX: Restart Language Server** | `corex.restartServer` | Restarts the active `corex lsp` server and reloads configuration. |
| **CoreX: Show Output Channel** | `corex.showOutputChannel` | Opens the **CoreX** Output panel with server status and diagnostic logs. |

<br>

## <a href="#recommended-settings"><img src="https://svg.xul.is/icon/sliders-horizontal?size=32&stroke=2" align="left" /></a>Recommended Settings

For the best CoreX editing experience, add the following options to your `settings.json` (pairs great with [**Isolux Theme**](https://open-vsx.org/extension/xulbux/theme-isolux)):

```jsonc
{
  // Format .cx files automatically on save:
  "[corex]": {
    "editor.formatOnSave": true,
    "editor.insertSpaces": true,
    "editor.semanticHighlighting.enabled": true,
    "editor.tabSize": 4
  },
  // Enable colorization and active guides for (), [], and {} brackets:
  "editor.bracketPairColorization.enabled": true,
  "editor.bracketPairColorization.independentColorPoolPerBracketType": true,
  "editor.guides.bracketPairs": "active"
}
```

<br>
<br>

## <a href="#troubleshooting"><img src="https://svg.xul.is/icon/bug?size=32&stroke=2" align="left" /></a>Troubleshooting

If live diagnostics, navigation, or formatting aren't working as expected, check the extension output:

1.  Open the **Output** panel (menu **View → Output**, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd>, or run **CoreX: Show Output Channel**).

2.  Select **CoreX** from the dropdown in the top-right corner of the panel.

3.  Make sure Workspace Trust is granted; in untrusted or virtual workspaces, external `corex` commands are paused and only syntax highlighting stays active.

<br>
<br>
<br>

## Enjoying this extension?&numsp;Have suggestions?

Please consider giving a [![star](https://svg.xul.is/icon/star?size=20&anim=shake)](https://github.com/corex-lang/vscode-ext-corex) on [**GitHub**](https://github.com/corex-lang/vscode-ext-corex) or leaving a review on [**Open VSX**](https://open-vsx.org/extension/corex-lang/corex) or the [**Visual Studio Marketplace**](https://marketplace.visualstudio.com/items?itemName=corex-lang.corex).

<br>
<br>
<br>

---

<br>
<div align="center">

From [**XulbuX**](https://xulbux.com)<br>
**ദ്ദി(˵ •̀ ᴗ - ˵ ) ✧**

</div>

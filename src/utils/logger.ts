/**
 * Logger – Lazy monochrome logging to the dedicated `CoreX` VS Code output channel.
 *
 * Defers `OutputChannel` allocation until the first diagnostic, lifecycle event, or JSON-RPC
 * trace entry is emitted so extension activation incurs zero host UI overhead.
 *
 * Truncates untrusted error details and trace payloads to bounded sizes using monochrome glyphs.
 */

// oxlint-disable-next-line unicorn/prefer-export-from -- value binding avoids esbuild CJS getter re-export overhead
import { window, workspace } from 'vscode';
import type { OutputChannel } from 'vscode';

// --------------------------------------- CONSTS ----------------------------------------

/** Shared mangleable alias for `vscode.window`. */
export const vsWindow = window;

/** Shared mangleable alias for `vscode.workspace`. */
export const vsWorkspace = workspace;

// -------------------------------------- INTERNALS --------------------------------------

/** Lazily initialized singleton VS Code output channel instance. */
let outputChannel: OutputChannel | undefined = undefined;

/** Returns the `CoreX` `'log'` output channel, creating it lazily on first access. */
function ensureChannel(): OutputChannel {
  return (outputChannel ??= vsWindow.createOutputChannel('CoreX', 'log'));
}

/**
 * Appends a timestamped monochrome log line with an optional bounded detail block.
 *
 * @param glyph       Monochrome prefix symbol (`•`, `⚠`, `✗`, `▸ ->`, `▸ <-`).
 * @param message     Primary log summary text.
 * @param detail      Optional caught error or JSON-RPC trace payload.
 * @param maxLength   Maximum UTF-16 code-unit length for `detail`.
 */
function appendLogLine(glyph: string, message: string, detail?: unknown, maxLength = 4096): void {
  const errText = detail instanceof Error ? (detail.stack ?? detail.message) : `${detail ?? ''}`;
  const clipped = errText.length > maxLength ? `${errText.slice(0, maxLength)}…` : errText;
  ensureChannel().appendLine(
    `[${new Date().toISOString()}] ${glyph} ${message}${clipped && `\n${clipped}`}`
  );
}

// ------------------------------------- PUBLIC API --------------------------------------

/** Returns the `CoreX` `'log'` output channel, creating it lazily on first access. */
export const getOutputChannel = ensureChannel;

/**
 * Reveals the `CoreX` output channel in the VS Code panel.
 *
 * @param isPreservingFocus   Whether editor focus should remain unchanged (`false` by default).
 */
export function showOutputChannel(isPreservingFocus?: boolean): void {
  ensureChannel().show(Boolean(isPreservingFocus));
}

/** Appends informational, warning, and error lifecycle messages to the `CoreX` output channel. */
export const [logInfo, logWarn, logError] = ([...'•⚠✗'] as [string, string, string]).map(
  (glyph) => (message: string, error?: unknown) => appendLogLine(glyph, message, error)
) as [
  (message: string, error?: unknown) => void,
  (message: string, error?: unknown) => void,
  (message: string, error?: unknown) => void,
];

/**
 * Appends a JSON-RPC 2.0 traffic trace entry to the `CoreX` output channel.
 *
 * @param direction   Message direction (`'send'` to server or `'receive'` from server).
 * @param summary     Concise method/id header line.
 * @param payload     Optional serialized JSON body when `corex.trace.server` is `'verbose'`.
 */
export function logTrace(direction: 'send' | 'receive', summary: string, payload?: string): void {
  appendLogLine(`▸ ${direction === 'send' ? '->' : '<-'}`, summary, payload, 16_384);
}

/** Disposes the `CoreX` output channel if it was initialized. */
export function disposeLogger(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}

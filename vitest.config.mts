/**
 * Vitest Configuration – Headless test runner setup for `vscode-ext-corex`.
 *
 * Maps `@/*` imports to `src/*` and redirects `vscode` host imports to `test/__mocks__/vscode.ts`
 * so unit, TextMate grammar, and `corex lsp` integration suites run directly in Node.
 *
 * All test suites inside `test/` execute with isolated module resolution.
 */

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      vscode: path.resolve(import.meta.dirname, 'test/__mocks__/vscode.ts'),
    },
  },
  test: { globals: true, include: ['test/**/*.test.ts'], root: '.' },
});

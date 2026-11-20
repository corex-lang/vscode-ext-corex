/**
 * TextMate Grammar & Language Configuration Verification – Scope & ReDoS suite for CoreX.
 *
 * Loads live `vscode-oniguruma` (`onig.wasm`) and `vscode-textmate` grammars for `source.corex`
 * and `markdown.corex.codeblock`, verifying all 3 scope invariants across `../corex/core/` modules,
 * `../corex/docs/COMPARISONS.md` showcases, and the complete `DR-22` lexical taxonomy.
 *
 * Enforces `< 50 ms` non-backtracking execution across 4000-character adversarial inputs.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { INITIAL, parseRawGrammar, Registry } from 'vscode-textmate';
import type { IGrammar, IOnigLib, IRawGrammar, StateStack } from 'vscode-textmate';

// ---------------------------------------- TYPES ----------------------------------------

/** Single non-whitespace token slice paired with its full TextMate scope stack. */
interface ScopedLexeme {
  /** Zero-based end column on `line`. */
  readonly endIndex: number;
  /** Innermost scope (`scopes[scopes.length - 1]`). */
  readonly leafScope: string;
  /** Exact source substring `[startIndex, endIndex)`. */
  readonly lexeme: string;
  /** Zero-based line index in the tokenized snippet. */
  readonly line: number;
  /** Complete TextMate scope stack from outermost to innermost. */
  readonly scopes: readonly string[];
  /** Zero-based start column on `line`. */
  readonly startIndex: number;
}

/** Shape of `language-configuration.json` fields containing regular expressions. */
interface LanguageConfigurationSchema {
  /** Folding marker patterns. */
  readonly folding?: {
    /** Start and end region regex strings. */
    readonly markers?: {
      /** End region regex string. */
      readonly end?: string;
      /** Start region regex string. */
      readonly start?: string;
    };
  };
  /** Automatic indentation rules. */
  readonly indentationRules?: {
    /** Decrease indent regex string. */
    readonly decreaseIndentPattern?: string;
    /** Increase indent regex string. */
    readonly increaseIndentPattern?: string;
  };
  /** Enter-key continuation rules. */
  readonly onEnterRules?: readonly {
    /** Optional regex matching text after cursor. */
    readonly afterText?: string;
    /** Regex matching text before cursor. */
    readonly beforeText: string;
  }[];
  /** Identifier word selection pattern. */
  readonly wordPattern?: string;
}

// --------------------------------------- CONSTS ----------------------------------------

/** Extension repository root (`D:\GitHub\vscode-ext-corex`). */
const EXT_ROOT = path.resolve(import.meta.dirname, '..');

/** Sibling CoreX compiler repository root (`D:\GitHub\corex`). */
const COREX_ROOT = path.resolve(EXT_ROOT, '..', 'corex');

/** Path to `syntaxes/corex.tmLanguage.json`. */
const COREX_GRAMMAR_PATH = path.resolve(EXT_ROOT, 'syntaxes', 'corex.tmLanguage.json');

/** Path to `syntaxes/corex.markdown.tmLanguage.json`. */
const MARKDOWN_INJECTION_PATH = path.resolve(
  EXT_ROOT,
  'syntaxes',
  'corex.markdown.tmLanguage.json'
);

/** Path to `language-configuration.json`. */
const LANGUAGE_CONFIG_PATH = path.resolve(EXT_ROOT, 'language-configuration.json');

/** Path to `vscode-oniguruma`'s WebAssembly binary. */
const ONIG_WASM_PATH = path.resolve(
  EXT_ROOT,
  'node_modules',
  'vscode-oniguruma',
  'release',
  'onig.wasm'
);

/** Minimal Markdown host grammar into which `markdown.corex.codeblock` is injected. */
const STUB_MARKDOWN_GRAMMAR = JSON.stringify({
  name: 'MarkdownStub',
  patterns: [{ match: '.+', name: 'markup.raw.prose.markdown' }],
  repository: {},
  scopeName: 'text.html.markdown',
});

/** Allowed top-level prefixes for innermost leaf scopes inside `source.corex` (SKILL.md §3). */
const ALLOWED_LEAF_PREFIXES: ReadonlySet<string> = new Set<string>([
  'comment',
  'constant',
  'entity',
  'keyword',
  'punctuation',
  'storage',
  'string',
  'support',
  'variable',
]);

/** Canonical 50 reserved CoreX keywords (`TokenKind` `0..49` in `stage0/src/syntax_arenas.zig`). */
const RESERVED_KEYWORDS = [
  'Self',
  'and',
  'as',
  'async',
  'await',
  'bit_field',
  'break',
  'catch',
  'comptime',
  'const',
  'context',
  'continue',
  'defer',
  'else',
  'enum',
  'errdefer',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'is',
  'let',
  'loop',
  'match',
  'mod',
  'mut',
  'not',
  'or',
  'orelse',
  'own',
  'pub',
  'return',
  'self',
  'struct',
  'subscript',
  'trait',
  'true',
  'type',
  'union',
  'unreachable',
  'unsafe',
  'use',
  'var',
  'where',
  'while',
  'with',
  'yield',
] as const;

/** Canonical 20 built-in CoreX primitive types (`TokenKind.prim_type = 50`). */
const PRIMITIVE_TYPES = [
  'bool',
  'char',
  'f32',
  'f64',
  'i128',
  'i16',
  'i32',
  'i64',
  'i8',
  'isize',
  'never',
  'opaque',
  'str',
  'u128',
  'u16',
  'u32',
  'u64',
  'u8',
  'unit',
  'usize',
] as const;

/** Canonical 12 built-in Constrained Type Groups (`support.type.group.corex`). */
const CONSTRAINED_TYPE_GROUPS = [
  'Bytes',
  'Comparable',
  'Copy',
  'Equatable',
  'Float',
  'FromBytes',
  'Integer',
  'IntoBytes',
  'Number',
  'Scalar',
  'Signed',
  'Unsigned',
] as const;

/** Canonical 11 contextual keywords in CoreX (`DR-22`). */
const CONTEXTUAL_KEYWORDS = [
  'any',
  'bench',
  'distinct',
  'dyn',
  'inout',
  'out',
  'pkg',
  'raw',
  'static',
  'super',
  'test',
] as const;

// ----------------------------------- REGEX PATTERNS ------------------------------------

/** Matches `LF` or `CRLF` line breaks without backtracking. */
const LINE_SPLIT_RX = /\r?\n/;

/** Matches fenced ```` ```cx ```` code blocks inside Markdown documents without backtracking. */
const CX_FENCED_BLOCK_RX = /^```cx[ \t]*\r?\n(?<body>[\s\S]*?)^```[ \t]*$/gm;

// -------------------------------------- INTERNALS --------------------------------------

/** Loaded `source.corex` TextMate grammar instance. */
let corexGrammar: IGrammar | undefined = undefined;

/** Loaded `text.html.markdown` grammar with `markdown.corex.codeblock` injected. */
let markdownGrammar: IGrammar | undefined = undefined;

/** Shared `vscode-textmate` registry disposed after suite completion. */
let grammarRegistry: Registry | undefined = undefined;

/**
 * Recursively collects all `.cx` file paths beneath `dirPath` in deterministic sorted order.
 *
 * @param dirPath   Root directory to scan.
 */
async function collectCxFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      for (const nested of await collectCxFiles(fullPath)) {
        results.push(nested);
      }
    } else if (entry.isFile() && entry.name.endsWith('.cx')) {
      results.push(fullPath);
    }
  }
  results.sort();
  return results;
}

/**
 * Extracts all ```` ```cx ```` fenced code blocks from `markdownSource`.
 *
 * @param markdownSource   Raw Markdown text (`COMPARISONS.md`).
 */
function extractCxShowcases(markdownSource: string): string[] {
  const blocks: string[] = [];
  CX_FENCED_BLOCK_RX.lastIndex = 0;
  let match = CX_FENCED_BLOCK_RX.exec(markdownSource);
  while (match !== null) {
    const codeBody = match.groups?.body;
    if (codeBody !== undefined) {
      blocks.push(codeBody);
    }
    match = CX_FENCED_BLOCK_RX.exec(markdownSource);
  }
  return blocks;
}

/**
 * Tokenizes `sourceText` with `grammar` and returns all non-whitespace `ScopedLexeme` entries.
 *
 * @param grammar      Target `IGrammar` (`source.corex` or `text.html.markdown`).
 * @param sourceText   Source buffer to tokenize line by line.
 */
function tokenizeNonWhitespace(grammar: IGrammar, sourceText: string): ScopedLexeme[] {
  const lines = sourceText.split(LINE_SPLIT_RX);
  const out: ScopedLexeme[] = [];
  let ruleStack: StateStack = INITIAL;

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i] ?? '';
    const {
      ruleStack: nextStack,
      stoppedEarly,
      tokens,
    } = grammar.tokenizeLine(lineText, ruleStack);
    expect(stoppedEarly).toBe(false);
    ruleStack = nextStack;

    for (const token of tokens) {
      const lexeme = lineText.slice(token.startIndex, token.endIndex);
      if (lexeme.trim().length > 0) {
        out.push({
          endIndex: token.endIndex,
          leafScope: token.scopes.at(-1) ?? '',
          lexeme,
          line: i,
          scopes: token.scopes,
          startIndex: token.startIndex,
        });
      }
    }
  }
  return out;
}

/**
 * Verifies all 3 strict TextMate scope invariants from `.agents/skills/test/SKILL.md` §3.
 *
 * @param tokensLabel   Diagnostic label identifying the file or showcase under test.
 * @param tokens        Non-whitespace tokens returned by `tokenizeNonWhitespace`.
 */
function assertStrictCorexScopeInvariants(
  tokensLabel: string,
  tokens: readonly ScopedLexeme[]
): void {
  expect(tokens.length).toBeGreaterThan(0);
  for (const token of tokens) {
    const locTag = `${tokensLabel}:${token.line + 1}:${token.startIndex + 1} (${JSON.stringify(token.lexeme)})`;
    expect(token.scopes.length, `Invariant 1 (depth > 1) failed at ${locTag}`).toBeGreaterThan(1);

    expect(
      token.leafScope.startsWith('source.') || token.leafScope.startsWith('meta.'),
      `Invariant 2 (non-container leaf) failed at ${locTag}: ${token.scopes.join(' > ')}`
    ).toBe(false);
    expect(
      ALLOWED_LEAF_PREFIXES.has(token.leafScope.split('.')[0] ?? ''),
      `Unexpected leaf scope category '${token.leafScope}' at ${locTag}`
    ).toBe(true);

    for (const scope of token.scopes) {
      expect(
        scope.startsWith('invalid.'),
        `Invariant 3 (zero invalid.*) failed at ${locTag}: ${token.scopes.join(' > ')}`
      ).toBe(false);
    }
  }
}

/**
 * Finds the `occurrence`-th token whose exact `lexeme` equals `targetLexeme`.
 *
 * @param tokens         Tokenized lexeme array.
 * @param targetLexeme   Exact token substring to locate.
 * @param occurrence     Zero-based match index (`0` by default).
 */
function findToken(
  tokens: readonly ScopedLexeme[],
  targetLexeme: string,
  occurrence = 0
): ScopedLexeme {
  let seen = 0;
  for (const token of tokens) {
    if (token.lexeme === targetLexeme) {
      if (seen === occurrence) {
        return token;
      }
      seen += 1;
    }
  }
  const lexemes: string[] = [];
  for (const token of tokens) {
    lexemes.push(token.lexeme);
  }
  throw new Error(
    `Token ${JSON.stringify(targetLexeme)} (#${occurrence}) not found in: ${lexemes.join(' ')}`
  );
}

/**
 * Returns `true` when `token.scopes` contains at least one scope matching `expectedPrefix`.
 *
 * @param token            Scoped token under inspection.
 * @param expectedPrefix   Exact scope or prefix (e.g., `'storage.type.primitive.corex'`).
 */
function hasScopeMatching(token: ScopedLexeme, expectedPrefix: string): boolean {
  for (const scope of token.scopes) {
    if (scope === expectedPrefix || scope.startsWith(`${expectedPrefix}.`)) {
      return true;
    }
  }
  return false;
}

/** Returns the initialized `source.corex` grammar or throws if `beforeAll` failed. */
function getCorexGrammar(): IGrammar {
  if (corexGrammar === undefined) {
    throw new Error('CoreX grammar was not initialized.');
  }
  return corexGrammar;
}

/** Returns the initialized `text.html.markdown` grammar or throws if `beforeAll` failed. */
function getMarkdownGrammar(): IGrammar {
  if (markdownGrammar === undefined) {
    throw new Error('Markdown injection grammar was not initialized.');
  }
  return markdownGrammar;
}

// ---------------------------------------- MAIN -----------------------------------------

beforeAll(async () => {
  const [wasmBytes, corexJson, markdownInjectionJson] = await Promise.all([
    readFile(ONIG_WASM_PATH),
    readFile(COREX_GRAMMAR_PATH, 'utf8'),
    readFile(MARKDOWN_INJECTION_PATH, 'utf8'),
  ]);
  await loadWASM(wasmBytes);

  grammarRegistry = new Registry({
    getInjections(scopeName: string): string[] | undefined {
      return scopeName === 'text.html.markdown' ? ['markdown.corex.codeblock'] : undefined;
    },
    loadGrammar(scopeName: string): Promise<IRawGrammar | null> {
      if (scopeName === 'source.corex') {
        return Promise.resolve(parseRawGrammar(corexJson, COREX_GRAMMAR_PATH));
      }
      if (scopeName === 'markdown.corex.codeblock') {
        return Promise.resolve(parseRawGrammar(markdownInjectionJson, MARKDOWN_INJECTION_PATH));
      }
      if (scopeName === 'text.html.markdown') {
        return Promise.resolve(
          parseRawGrammar(STUB_MARKDOWN_GRAMMAR, 'stub.markdown.tmLanguage.json')
        );
      }
      return Promise.resolve(null);
    },
    onigLib: Promise.resolve({ createOnigScanner, createOnigString } as unknown as IOnigLib),
  });

  corexGrammar = (await grammarRegistry.loadGrammar('source.corex')) ?? undefined;
  markdownGrammar = (await grammarRegistry.loadGrammar('text.html.markdown')) ?? undefined;
});

afterAll(() => {
  grammarRegistry?.dispose();
  grammarRegistry = undefined;
});

// ----------- Real Core Stdlib & Comparisons Corpus ------------

describe('Corpus scope invariants – ../corex/core/**/*.cx and ../corex/docs/COMPARISONS.md', () => {
  it('enforces all 3 strict scope invariants across all >= 14 real ../corex/core/**/*.cx modules', async () => {
    const cxFilePaths = await collectCxFiles(path.resolve(COREX_ROOT, 'core'));
    expect(cxFilePaths.length).toBeGreaterThanOrEqual(14);

    const grammar = getCorexGrammar();
    for (const filePath of cxFilePaths) {
      assertStrictCorexScopeInvariants(
        path.relative(COREX_ROOT, filePath),
        tokenizeNonWhitespace(grammar, await readFile(filePath, 'utf8'))
      );
    }
  });

  it('enforces all 3 strict scope invariants across all >= 9 fenced cx showcases in COMPARISONS.md', async () => {
    const showcases = extractCxShowcases(
      await readFile(path.resolve(COREX_ROOT, 'docs', 'COMPARISONS.md'), 'utf8')
    );
    expect(showcases.length).toBeGreaterThanOrEqual(9);

    const grammar = getCorexGrammar();
    for (let i = 0; i < showcases.length; i += 1) {
      assertStrictCorexScopeInvariants(
        `COMPARISONS.md#showcase-${i + 1}`,
        tokenizeNonWhitespace(grammar, showcases[i] ?? '')
      );
    }
  });

  it('injects source.corex scopes inside Markdown ```cx, ```corex, and ~~~{.corex} fenced blocks', () => {
    const markdownSample = [
      '# CoreX Documentation',
      '',
      '```cx',
      '@no_alloc',
      'pub fn square(val: i32) -> i32 {',
      '    return val * val;',
      '}',
      '```',
      '',
      '```corex',
      'pub struct Pair[T: Copy] {',
      '    pub left: T,',
      '    pub right: T,',
      '}',
      '```',
      '',
      '~~~{.corex}',
      'const LIMIT: usize = 64_usize;',
      '~~~',
    ].join('\n');

    const mdTokens = tokenizeNonWhitespace(getMarkdownGrammar(), markdownSample);
    const embeddedTokens: ScopedLexeme[] = [];
    for (const token of mdTokens) {
      if (hasScopeMatching(token, 'meta.embedded.block.corex')) {
        embeddedTokens.push(token);
      }
    }

    expect(embeddedTokens.length).toBeGreaterThan(20);
    assertStrictCorexScopeInvariants('markdown-injection', embeddedTokens);
    expect(findToken(embeddedTokens, 'pub', 0).leafScope).toBe('storage.modifier.corex');
    expect(findToken(embeddedTokens, 'square').leafScope).toBe('entity.name.function.corex');
    expect(findToken(embeddedTokens, 'i32', 0).leafScope).toBe('storage.type.primitive.corex');
    expect(findToken(embeddedTokens, 'Pair').leafScope).toBe('entity.name.type.corex');
    expect(findToken(embeddedTokens, 'Copy').leafScope).toBe('support.type.group.corex');
    expect(findToken(embeddedTokens, 'LIMIT').leafScope).toBe('entity.name.constant.corex');
  });
});

// --------- Keywords, Primitives, Contextual & Groups ----------

describe('DR-22 keywords, primitives, contextual keywords, and Constrained Type Groups', () => {
  it('tokenizes all 50 reserved keywords with exact lexical scopes and rejects identifier prefixes', () => {
    expect(RESERVED_KEYWORDS).toHaveLength(50);

    const allKeywordsSnippet = [
      'pub mod demo;',
      'use core.mem as mem_alias;',
      'pub struct Boxed { pub val: u32 }',
      'pub enum Choice { Alpha, Beta }',
      'pub union Words { pub raw_u32: u32 }',
      'pub bit_field Flags: u8 { pub bit0: u8 | 1 }',
      'pub trait Runnable { fn step(&self) -> Self; }',
      'pub type Alias = u32;',
      'pub const MAX_CAP: usize = 8;',
      'impl Runnable for Boxed where u32: Copy {',
      '    pub subscript(idx: usize) -> u32 { let { yield self.val; } }',
      '    fn step(&self) -> Self { return Boxed { val: self.val }; }',
      '}',
      'extern "C" { fn c_hook(ptr: *mut u8); }',
      'pub async fn exercise(own item: Boxed, slice_ref: &mut [u32]) -> u32!u8 {',
      '    let flag = true and not false or (1 is i32);',
      '    var acc: u32 = comptime { 0 };',
      '    defer { let _ = flag; }',
      '    errdefer { acc = 0; }',
      '    with context.allocator = context.allocator {',
      '        for elem in slice_ref {',
      '            if elem == 0 { continue; } else { acc += elem; }',
      '        }',
      '        while acc < 10 { break; }',
      '        loop { break; }',
      '    }',
      '    let opt_v: u32? = .Some(acc);',
      '    let unwrapped = opt_v orelse 0;',
      '    let res_v: u32!u8 = .Ok(unwrapped);',
      '    let handled = res_v catch 0;',
      '    unsafe { let _ = handled; }',
      '    await async { 1 };',
      '    match Choice.Alpha {',
      '        .Alpha => return .Ok(handled),',
      '        .Beta => unreachable,',
      '    }',
      '}',
    ].join('\n');

    const tokens = tokenizeNonWhitespace(getCorexGrammar(), allKeywordsSnippet);
    assertStrictCorexScopeInvariants('all-50-keywords', tokens);

    const matchedSet = new Set<string>();
    for (const token of tokens) {
      matchedSet.add(token.lexeme);
    }
    for (const kw of RESERVED_KEYWORDS) {
      expect(matchedSet.has(kw), `Missing reserved keyword '${kw}' in fixture`).toBe(true);
      const kwToken = findToken(tokens, kw);
      expect(
        kwToken.leafScope === 'variable.other.readwrite.corex',
        `Keyword '${kw}' fell through to plain identifier scope: ${kwToken.scopes.join(' > ')}`
      ).toBe(false);
    }

    const negTokens = tokenizeNonWhitespace(
      getCorexGrammar(),
      'let null = 0; let fn_name = 1; let own_value = 2; let u8_slice = 3; let true_flag = null + fn_name;'
    );
    assertStrictCorexScopeInvariants('negative-identifier-prefixes', negTokens);
    expect(findToken(negTokens, 'null', 0).leafScope).toBe('variable.other.constant.corex');
    expect(findToken(negTokens, 'null', 1).leafScope).toBe('variable.other.readwrite.corex');
    expect(findToken(negTokens, 'fn_name', 0).leafScope).toBe('variable.other.constant.corex');
    expect(findToken(negTokens, 'own_value', 0).leafScope).toBe('variable.other.constant.corex');
    expect(findToken(negTokens, 'u8_slice', 0).leafScope).toBe('variable.other.constant.corex');
    expect(findToken(negTokens, 'true_flag', 0).leafScope).toBe('variable.other.constant.corex');
  });

  it('tokenizes all 20 primitive types (including opaque) and all 12 Constrained Type Groups', () => {
    expect(PRIMITIVE_TYPES).toHaveLength(20);
    expect(CONSTRAINED_TYPE_GROUPS).toHaveLength(12);

    const primLines: string[] = [];
    for (let i = 0; i < PRIMITIVE_TYPES.length; i += 1) {
      primLines.push(`type P${i} = *${PRIMITIVE_TYPES[i]};`);
    }
    for (let i = 0; i < CONSTRAINED_TYPE_GROUPS.length; i += 1) {
      primLines.push(`fn g${i}[T: ${CONSTRAINED_TYPE_GROUPS[i]}](val: T) -> T { return val; }`);
    }

    const tokens = tokenizeNonWhitespace(getCorexGrammar(), primLines.join('\n'));
    assertStrictCorexScopeInvariants('primitives-and-groups', tokens);

    for (const prim of PRIMITIVE_TYPES) {
      expect(findToken(tokens, prim).leafScope).toBe('storage.type.primitive.corex');
    }
    for (const group of CONSTRAINED_TYPE_GROUPS) {
      expect(findToken(tokens, group).leafScope).toBe('support.type.group.corex');
    }
  });

  it('distinguishes all 11 contextual keywords in syntactic vs ordinary identifier positions', () => {
    expect(CONTEXTUAL_KEYWORDS).toHaveLength(11);

    const positiveContextual = [
      'pub(pkg) fn internal_pkg() {}',
      'pub(super) fn internal_super() {}',
      'type HandleId = distinct u64;',
      'extern "C" { static mut errno_val: i32; }',
      'pub fn probe(num: any Number, view: &dyn Display, slot: &out u32) {',
      '    let raw_ptr = &raw slot;',
      '    let raw_mut_ptr = &raw mut slot;',
      '    let _ = (num, view, raw_ptr, raw_mut_ptr);',
      '}',
      'impl Ring {',
      '    pub subscript(idx: usize) -> u32 {',
      '        inout { yield &mut self.buf[idx]; }',
      '    }',
      '}',
      'test "contextual test block" { }',
      'bench "contextual bench block" (bencher: &mut Bencher) { }',
    ].join('\n');

    const posTokens = tokenizeNonWhitespace(getCorexGrammar(), positiveContextual);
    assertStrictCorexScopeInvariants('contextual-positive', posTokens);

    expect(findToken(posTokens, 'pkg').leafScope).toBe('storage.modifier.visibility.scope.corex');
    expect(findToken(posTokens, 'super').leafScope).toBe('storage.modifier.visibility.scope.corex');
    expect(findToken(posTokens, 'distinct').leafScope).toBe('storage.modifier.distinct.corex');
    expect(findToken(posTokens, 'static').leafScope).toBe('keyword.declaration.static.corex');
    expect(findToken(posTokens, 'any').leafScope).toBe('storage.modifier.type.corex');
    expect(findToken(posTokens, 'dyn').leafScope).toBe('storage.modifier.type.corex');
    expect(findToken(posTokens, 'out').leafScope).toBe('storage.modifier.out.corex');
    expect(findToken(posTokens, 'raw', 0).leafScope).toBe('storage.modifier.raw.corex');
    expect(findToken(posTokens, 'raw', 1).leafScope).toBe('storage.modifier.raw.corex');
    expect(findToken(posTokens, 'inout').leafScope).toBe(
      'keyword.declaration.subscript.inout.corex'
    );
    expect(findToken(posTokens, 'test').leafScope).toBe('keyword.declaration.test.corex');
    expect(findToken(posTokens, 'bench').leafScope).toBe('keyword.declaration.test.corex');

    const negativeIdentifiers = [
      'fn pkg(out: u32) -> u32 {',
      '    let test = 1;',
      '    let bench = 2;',
      '    let raw = 3;',
      '    let distinct = 4;',
      '    let static = 5;',
      '    let inout = 6;',
      '    let any = 7;',
      '    let dyn = 8;',
      '    let super = 9;',
      '    return out + test + bench + raw + distinct + static + inout + any + dyn + super;',
      '}',
    ].join('\n');

    const negTokens = tokenizeNonWhitespace(getCorexGrammar(), negativeIdentifiers);
    assertStrictCorexScopeInvariants('contextual-negative', negTokens);

    expect(findToken(negTokens, 'pkg').leafScope).toBe('entity.name.function.corex');
    expect(findToken(negTokens, 'out', 0).leafScope).toBe('variable.parameter.corex');
    expect(findToken(negTokens, 'out', 1).leafScope).toBe('variable.other.readwrite.corex');

    const localContextualNames = [
      'test',
      'bench',
      'raw',
      'distinct',
      'static',
      'inout',
      'any',
      'dyn',
      'super',
    ];
    for (const identName of localContextualNames) {
      expect(findToken(negTokens, identName, 0).leafScope).toBe('variable.other.constant.corex');
      expect(findToken(negTokens, identName, 1).leafScope).toBe('variable.other.readwrite.corex');
    }
  });
});

// --- Nominal Types, Annotations, Headers & Nested Comments ----

describe('Types vs variants vs constants, @attributes, #soa, frontmatter, labels, and comments', () => {
  it('distinguishes Self, PascalCase types, enum variants, and SCREAMING_SNAKE_CASE constants', () => {
    const casingSnippet = [
      'const GLOBAL_MASK: u32 = 0xFF00_u32;',
      'pub enum PacketKind {',
      '    Ping,',
      '    Data(PayloadHeader),',
      '    Control { flags: u8 },',
      '    Reset = 255,',
      '}',
      'impl PacketKind {',
      '    pub fn default_kind() -> Self {',
      '        let mask = GLOBAL_MASK;',
      '        let _ = mask;',
      '        let explicit = PacketKind.Ping;',
      '        let _ = explicit;',
      '        return .Reset;',
      '    }',
      '}',
    ].join('\n');

    const tokens = tokenizeNonWhitespace(getCorexGrammar(), casingSnippet);
    assertStrictCorexScopeInvariants('casing-disjointness', tokens);

    expect(hasScopeMatching(findToken(tokens, 'GLOBAL_MASK', 0), 'constant.other.caps.corex')).toBe(
      true
    );
    expect(hasScopeMatching(findToken(tokens, 'GLOBAL_MASK', 1), 'constant.other.caps.corex')).toBe(
      true
    );
    expect(findToken(tokens, 'PacketKind', 0).leafScope).toBe('entity.name.type.enum.corex');
    expect(findToken(tokens, 'Ping', 0).leafScope).toBe('variable.other.enummember.corex');
    expect(findToken(tokens, 'Data').leafScope).toBe('variable.other.enummember.corex');
    expect(findToken(tokens, 'PayloadHeader').leafScope).toBe('entity.name.type.corex');
    expect(findToken(tokens, 'Control').leafScope).toBe('variable.other.enummember.corex');
    expect(findToken(tokens, 'Reset', 0).leafScope).toBe('variable.other.enummember.corex');
    expect(findToken(tokens, 'Self').leafScope).toBe('entity.name.type.self.corex');
    expect(findToken(tokens, 'PacketKind', 2).leafScope).toBe('entity.name.type.corex');
    expect(findToken(tokens, 'Ping', 1).leafScope).toBe('variable.other.enummember.corex');
    expect(findToken(tokens, 'Reset', 1).leafScope).toBe('variable.other.enummember.corex');
  });

  it('scopes @attr(key: val), @size_of, #soa, shebang + TOML frontmatter, labels, and nested /* … */ comments', () => {
    const scriptWithHeader = [
      '#!/usr/bin/env corex',
      '---',
      '# Script manifest comment',
      '[dependencies]',
      'json-wire = { version = "1.4.0", allow_caps = [] }',
      String.raw`[target."cfg(target = \"windows\")".dependencies]`,
      'win-sys = "0.2.0"',
      'updated_at = 2026-11-20T12:00:00Z',
      'limit = +inf',
      '---',
      '/* outer block /* nested middle /* inner leaf */ still comment */ end of block */',
      '@deprecated(since: "0.2.0", reason: "legacy")',
      'pub fn compute(slice_soa: #soa &[Particle], raw_c: *c_void) -> usize {',
      '    let c_float = 1.0_f32;',
      '    let c_size_t = 0_usize;',
      '    let _ = (raw_c, c_float, c_size_t);',
      '    errdefer |err| { let _ = err; }',
      '    let stride = @size_of[usize]();',
      '    fsm: match State.Idle {',
      '        .Idle => continue :fsm .Done,',
      '        .Done => break:fsm stride,',
      '    }',
      '}',
    ].join('\n');

    const tokens = tokenizeNonWhitespace(getCorexGrammar(), scriptWithHeader);
    assertStrictCorexScopeInvariants('headers-attrs-labels-comments', tokens);

    expect(findToken(tokens, '#!').leafScope).toBe('punctuation.definition.comment.shebang.corex');
    expect(findToken(tokens, '---', 0).leafScope).toBe(
      'punctuation.definition.separator.frontmatter.corex'
    );
    expect(findToken(tokens, 'dependencies', 0).leafScope).toBe(
      'entity.name.section.table.toml.corex'
    );
    expect(findToken(tokens, 'dependencies', 1).leafScope).toBe('variable.other.key.toml.corex');
    expect(findToken(tokens, 'json-wire').leafScope).toBe('variable.other.key.toml.corex');
    expect(findToken(tokens, '2026-11-20T12:00:00Z').leafScope).toBe(
      'constant.other.datetime.toml.corex'
    );
    expect(findToken(tokens, '+inf').leafScope).toBe('constant.numeric.toml.corex');
    expect(findToken(tokens, 'c_void').leafScope).toBe('support.type.builtin.ffi.corex');
    expect(findToken(tokens, 'c_float', 0).leafScope).toBe('variable.other.constant.corex');
    expect(findToken(tokens, 'c_size_t', 0).leafScope).toBe('variable.other.constant.corex');
    expect(findToken(tokens, '|', 0).leafScope).toBe(
      'punctuation.definition.parameters.begin.corex'
    );
    expect(findToken(tokens, 'err', 0).leafScope).toBe('variable.parameter.corex');
    expect(findToken(tokens, '|', 1).leafScope).toBe('punctuation.definition.parameters.end.corex');

    expect(findToken(tokens, '@', 0).leafScope).toBe('punctuation.definition.annotation.corex');
    expect(findToken(tokens, 'deprecated').leafScope).toBe('storage.type.annotation.corex');
    expect(findToken(tokens, 'since').leafScope).toBe('variable.other.property.corex');

    expect(findToken(tokens, '@', 1).leafScope).toBe('punctuation.definition.annotation.corex');
    expect(findToken(tokens, 'size_of').leafScope).toBe('storage.type.annotation.corex');

    expect(findToken(tokens, '#', 1).leafScope).toBe('punctuation.definition.directive.corex');
    expect(findToken(tokens, 'soa').leafScope).toBe('storage.modifier.soa.corex');

    expect(findToken(tokens, 'fsm', 0).leafScope).toBe('entity.name.label.corex');
    expect(findToken(tokens, 'fsm', 1).leafScope).toBe('entity.name.label.corex');
    expect(findToken(tokens, 'fsm', 2).leafScope).toBe('entity.name.label.corex');

    expect(findToken(tokens, 'pub').leafScope).toBe('storage.modifier.corex');
    expect(findToken(tokens, 'compute').leafScope).toBe('entity.name.function.corex');

    const nonReenteringShebang = [
      '#!/usr/bin/env corex',
      '---',
      '[package]',
      'name = "once-only"',
      '---',
      '---',
      'pub fn main() -> i32 { return 0; }',
    ].join('\n');
    const onceTokens = tokenizeNonWhitespace(getCorexGrammar(), nonReenteringShebang);
    expect(findToken(onceTokens, 'main').leafScope).toBe('entity.name.function.corex');
    expect(
      hasScopeMatching(findToken(onceTokens, 'main'), 'meta.embedded.block.frontmatter.toml.corex')
    ).toBe(false);

    const bareFrontmatter = [
      '---',
      '[package]',
      'name = "script-only"',
      '---',
      'pub fn main() -> i32 { return 0; }',
    ].join('\n');
    const bareTokens = tokenizeNonWhitespace(getCorexGrammar(), bareFrontmatter);
    assertStrictCorexScopeInvariants('bare-frontmatter', bareTokens);
    expect(findToken(bareTokens, '---', 0).leafScope).toBe(
      'punctuation.definition.separator.frontmatter.corex'
    );
    expect(findToken(bareTokens, 'package').leafScope).toBe('entity.name.section.table.toml.corex');
  });
});

// --------- Strings, Interpolation, Numbers & Closures ---------

describe('Strings, recursive {expr=:#06x} interpolation, numbers, and closure vs bitwise |', () => {
  it('tokenizes all 10 string/raw-string/byte-string/char/byte-char forms and nested {expr=:#06x} interpolation', () => {
    const literalsSnippet = [
      String.raw`let s_double = "hello {{world}} \n \x2A \u{03BB}";`,
      'let s_triple = """',
      '    line one {1 + 2=:#06x}',
      '    """;',
      String.raw`let s_raw = r#"raw "quoted" \n no-escape"#;`,
      'let s_raw_triple = r#"""',
      '    raw multiline """body"""',
      '    """#;',
      String.raw`let b_double = b"ascii \x7F \r\n";`,
      'let b_triple = b"""',
      String.raw`    cooked byte block \x00`,
      '    """;',
      String.raw`let br_single = br#"raw \xFF bytes"#;`,
      'let br_triple = br#"""',
      '    raw byte multiline',
      '    """#;',
      String.raw`let ch_utf8 = '\u{10348}';`,
      String.raw`let ch_byte = b'\x41';`,
      'let nested_interp = "outer {format_tag("inner {val=:#04x}")=}";',
      'let var_specs = "{x:?} {addr:#010x} {mask:08b} {ratio:.2f} {name:>12} {val:─^10} {self:#x} {true:?}";',
    ].join('\n');

    const tokens = tokenizeNonWhitespace(getCorexGrammar(), literalsSnippet);
    assertStrictCorexScopeInvariants('all-string-and-char-forms', tokens);

    expect(findToken(tokens, '{{').leafScope).toBe('constant.character.escape.brace.corex');
    expect(findToken(tokens, 'world').leafScope).toBe('string.quoted.double.corex');
    expect(findToken(tokens, '}}').leafScope).toBe('constant.character.escape.brace.corex');
    expect(findToken(tokens, ':#06x').leafScope).toBe('storage.type.format.corex');
    expect(findToken(tokens, ':#04x').leafScope).toBe('storage.type.format.corex');
    expect(findToken(tokens, 'addr').leafScope).toBe('variable.other.readwrite.corex');
    expect(findToken(tokens, ':?').leafScope).toBe('storage.type.format.corex');
    expect(findToken(tokens, ':#010x').leafScope).toBe('storage.type.format.corex');
    expect(findToken(tokens, ':08b').leafScope).toBe('storage.type.format.corex');
    expect(findToken(tokens, ':.2f').leafScope).toBe('storage.type.format.corex');
    expect(findToken(tokens, ':>12').leafScope).toBe('storage.type.format.corex');
    expect(findToken(tokens, ':─^10').leafScope).toBe('storage.type.format.corex');
    expect(findToken(tokens, 'self').leafScope).toBe('variable.language.self.corex');
    expect(findToken(tokens, 'true').leafScope).toBe('constant.language.boolean.corex');
    expect(findToken(tokens, 'r').leafScope).toBe('punctuation.definition.string.begin.corex');
    expect(findToken(tokens, 'br', 0).leafScope).toBe('punctuation.definition.string.begin.corex');
  });

  it(
    String.raw`recovers at EOL on unclosed strings, continues across trailing \, and flags invalid escapes`,
    () => {
      const recoveryAndContinuation = [
        'let broken = "unterminated string literal',
        'let recovered_after_eol = 42;',
        `let continued = "first line ${String.fromCharCode(92)}`,
        'second line";',
        'let after_continued = 99;',
      ].join('\n');

      const tokens = tokenizeNonWhitespace(getCorexGrammar(), recoveryAndContinuation);
      assertStrictCorexScopeInvariants('eol-recovery-and-continuation', tokens);

      expect(findToken(tokens, 'let', 1).leafScope).toBe('keyword.declaration.variable.corex');
      expect(findToken(tokens, 'recovered_after_eol').leafScope).toBe(
        'variable.other.constant.corex'
      );
      expect(findToken(tokens, '\\').leafScope).toBe(
        'constant.character.escape.line-continuation.corex'
      );
      expect(hasScopeMatching(findToken(tokens, 'second line'), 'string.quoted.double.corex')).toBe(
        true
      );
      expect(findToken(tokens, 'after_continued').leafScope).toBe('variable.other.constant.corex');

      const badTokens = tokenizeNonWhitespace(
        getCorexGrammar(),
        String.raw`let bad_str = "illegal \{ \q"; let bad_byte = b"\u{0041}";`
      );
      expect(findToken(badTokens, String.raw`\{`).leafScope).toBe(
        'invalid.illegal.escape.brace.corex'
      );
      expect(findToken(badTokens, String.raw`\q`).leafScope).toBe('invalid.illegal.escape.corex');
      expect(findToken(badTokens, String.raw`\u{0041}`).leafScope).toBe(
        'invalid.illegal.escape.unicode-in-byte.corex'
      );
    }
  );

  it('tokenizes _-separated SE-13 numeric suffixes and disambiguates |x| closures from a | b | c bitwise OR', () => {
    const numbersAndClosures = [
      'let hex_byte = 0xFF_u8;',
      'let bin_word = 0b1010_0101_u16;',
      'let oct_perm = 0o755_u32;',
      'let dec_size = 1_000_usize;',
      'let flt_val = 3.1415_f32 + 1.5e-4_f64;',
      'let mapper = |x: i32, own payload| x + 1;',
      'let thunk = || 0_i32;',
      'let bit_mask = flag_a | flag_b | flag_c;',
    ].join('\n');

    const tokens = tokenizeNonWhitespace(getCorexGrammar(), numbersAndClosures);
    assertStrictCorexScopeInvariants('numbers-and-closures', tokens);

    expect(findToken(tokens, 'u8').leafScope).toBe('keyword.other.unit.corex');
    expect(findToken(tokens, 'u16').leafScope).toBe('keyword.other.unit.corex');
    expect(findToken(tokens, 'u32').leafScope).toBe('keyword.other.unit.corex');
    expect(findToken(tokens, 'usize').leafScope).toBe('keyword.other.unit.corex');
    expect(findToken(tokens, 'f32').leafScope).toBe('keyword.other.unit.corex');
    expect(findToken(tokens, 'f64').leafScope).toBe('keyword.other.unit.corex');

    expect(findToken(tokens, '|', 0).leafScope).toBe(
      'punctuation.definition.parameters.begin.corex'
    );
    expect(findToken(tokens, 'x', 0).leafScope).toBe('variable.parameter.corex');
    expect(findToken(tokens, 'payload').leafScope).toBe('variable.parameter.corex');
    expect(findToken(tokens, '|', 1).leafScope).toBe('punctuation.definition.parameters.end.corex');
    expect(findToken(tokens, '||').leafScope).toBe('punctuation.definition.parameters.empty.corex');

    expect(findToken(tokens, '|', 2).leafScope).toBe('keyword.operator.bitwise.corex');
    expect(findToken(tokens, 'flag_b').leafScope).toBe('variable.other.readwrite.corex');
    expect(findToken(tokens, '|', 3).leafScope).toBe('keyword.operator.bitwise.corex');

    const badSuffixTokens = tokenizeNonWhitespace(getCorexGrammar(), 'let bad_unit = 100_ms;');
    let hasInvalidDigit = false;
    for (const tok of badSuffixTokens) {
      if (tok.leafScope === 'invalid.illegal.character.corex') {
        hasInvalidDigit = true;
        break;
      }
    }
    expect(hasInvalidDigit).toBe(true);
  });
});

// --------------- ReDoS Non-Backtracking Latency ---------------

describe('Non-backtracking ReDoS latency (< 50 ms on 4000-char adversarial lines)', () => {
  it('tokenizes 4000-character adversarial lines in < 50 ms without catastrophic backtracking', () => {
    const grammar = getCorexGrammar();
    const adversarialLines = [
      `let chain = ${'pkg_mod_long_segment_name.'.repeat(165)}unmatched_tail;`,
      `let bitwise = alpha | ${'beta_identifier_name + '.repeat(180)}omega | gamma;`,
      `let generics = invoke_fn[${'LongTypeIdentifierName, '.repeat(170)}unclosed`,
      `if (walrus_candidate: ${'LongTypeSegment '.repeat(255)}unclosed`,
      `let interp = "prefix {${'long_variable_identifier + '.repeat(150)}tail=:#06x}";`,
      `/// ${'documentation_token_segment '.repeat(150)}`,
      `x.foo[A${'a'.repeat(4005)}`,
      `let cls = |A${'a'.repeat(4005)}_| x;`,
      `let qual = A${'a'.repeat(2005)}.B${'b'.repeat(2005)}_;`,
      `foo[A${'a'.repeat(4005)}`,
      `let pascal = A${'a'.repeat(4005)};`,
    ];

    for (const longLine of adversarialLines) {
      expect(longLine.length).toBeGreaterThanOrEqual(4000);
      grammar.tokenizeLine(longLine.slice(0, 64), INITIAL);
      let bestElapsed = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const startTime = performance.now();
        expect(grammar.tokenizeLine(longLine, INITIAL).stoppedEarly).toBe(false);
        bestElapsed = Math.min(bestElapsed, performance.now() - startTime);
      }
      expect(bestElapsed).toBeLessThan(50);
    }
  });

  it('evaluates all language-configuration.json regex rules in < 50 ms on 4000-character lines', async () => {
    const rawConfig = JSON.parse(
      await readFile(LANGUAGE_CONFIG_PATH, 'utf8')
    ) as LanguageConfigurationSchema;

    const patternSources: string[] = [];
    if (rawConfig.wordPattern) {
      patternSources.push(rawConfig.wordPattern);
    }
    if (rawConfig.indentationRules?.increaseIndentPattern) {
      patternSources.push(rawConfig.indentationRules.increaseIndentPattern);
    }
    if (rawConfig.indentationRules?.decreaseIndentPattern) {
      patternSources.push(rawConfig.indentationRules.decreaseIndentPattern);
    }
    if (rawConfig.folding?.markers?.start) {
      patternSources.push(rawConfig.folding.markers.start);
    }
    if (rawConfig.folding?.markers?.end) {
      patternSources.push(rawConfig.folding.markers.end);
    }
    for (const enterRule of rawConfig.onEnterRules ?? []) {
      patternSources.push(enterRule.beforeText);
      if (enterRule.afterText) {
        patternSources.push(enterRule.afterText);
      }
    }

    expect(patternSources.length).toBeGreaterThanOrEqual(12);

    const compiledRegexes: RegExp[] = [];
    for (const source of patternSources) {
      compiledRegexes.push(new RegExp(source));
    }

    const adversarialInputs = [
      `${' '.repeat(2000)}{${'a / b '.repeat(350)}`,
      `/* ${'*'.repeat(4000)}`,
      `/// ${'x'.repeat(4000)}`,
      `${'fn_call('.repeat(500)}`,
    ];

    for (const regex of compiledRegexes) {
      for (const candidate of adversarialInputs) {
        expect(candidate.length).toBeGreaterThanOrEqual(4000);
        const startTime = performance.now();
        regex.test(candidate);
        expect(performance.now() - startTime).toBeLessThan(50);
      }
    }
  });
});

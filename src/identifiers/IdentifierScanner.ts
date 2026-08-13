import * as vscode from 'vscode';
import { IdentifierRole, IdentifierToken, SourceScript } from '../types';

// Unicode script ranges used to decide "is this identifier non-English and
// therefore a translation candidate at all". Deliberately conservative:
// mixed-script identifiers (rare) are classified by their dominant script.
const SCRIPT_PATTERNS: [SourceScript, RegExp][] = [
  ['zh', /\p{Script=Han}/u],
  ['ja', /[\u3040-\u30ff]/u], // hiragana/katakana; kanji-only text is caught by Han above and still fine to treat as zh/ja ambiguous
  ['ko', /\p{Script=Hangul}/u],
  ['ar', /\p{Script=Arabic}/u],
  ['ru', /\p{Script=Cyrillic}/u],
];

const IDENTIFIER_RE = /[\p{L}_][\p{L}\p{N}_]*/gu;

// Minimal denylist to avoid translating language keywords caught by the
// fallback regex path (semantic-token path doesn't need this, since
// keywords aren't tagged as variable/function/class tokens).
const KEYWORD_DENYLIST = new Set([
  'if', 'else', 'for', 'while', 'return', 'class', 'void', 'int', 'string',
  'const', 'let', 'var', 'function', 'def', 'public', 'private', 'static',
  'import', 'export', 'from', 'namespace', 'struct', 'enum', 'interface',
]);

function detectScript(text: string): SourceScript {
  for (const [script, pattern] of SCRIPT_PATTERNS) {
    if (pattern.test(text)) return script;
  }
  return /[A-Za-z]/.test(text) ? 'en' : 'unknown';
}

/**
 * Maps a VS Code SemanticTokenTypes string to our coarse IdentifierRole.
 * Falls back to 'unknown' for anything not directly relevant (keywords,
 * operators, comments, strings, etc. are filtered out by the caller before
 * this is ever invoked).
 */
function roleFromSemanticTokenType(tokenType: string): IdentifierRole {
  switch (tokenType) {
    case 'class':
    case 'interface':
    case 'struct':
    case 'enum':
      return 'class';
    case 'function':
    case 'method':
      return 'function';
    case 'variable':
    case 'property':
    case 'field':
      return 'variable';
    case 'parameter':
      return 'parameter';
    case 'namespace':
    case 'module':
      return 'namespace';
    case 'enumMember':
      return 'constant';
    default:
      return 'unknown';
  }
}

/**
 * Heuristic role inference for the regex-fallback path (used only when no
 * semantic tokens provider is registered for the document's language).
 * This is intentionally simple — it only needs to be "good enough" to pick
 * a naming convention (camelCase vs PascalCase), not perfectly correct.
 */
function inferRoleHeuristic(line: string, matchStart: number, text: string): IdentifierRole {
  const before = line.slice(0, matchStart).trimEnd();
  if (/\bclass\b\s*$/.test(before) || /\binterface\b\s*$/.test(before) || /\bstruct\b\s*$/.test(before)) {
    return 'class';
  }
  if (/\b(const|final|static\s+final)\b/.test(before)) {
    return 'constant';
  }
  if (/[)]\s*$/.test(before) === false && /\w+\s*\($/.test(line.slice(0, matchStart + text.length))) {
    return 'function';
  }
  return 'variable';
}

export class IdentifierScanner {
  /**
   * Preferred path: ask the already-active language server for semantic
   * tokens and filter to non-English-script ranges. This is what lets us
   * honestly claim "LSP integration preserved" — we consume the LSP's
   * output rather than re-implementing a parser.
   */
  static async scanViaSemanticTokens(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<IdentifierToken[] | null> {
    try {
      const legend = (await vscode.commands.executeCommand(
        'vscode.provideDocumentSemanticTokensLegend',
        document.uri
      )) as vscode.SemanticTokensLegend | undefined;
      const tokens = (await vscode.commands.executeCommand(
        'vscode.provideDocumentRangeSemanticTokens',
        document.uri,
        range
      )) as vscode.SemanticTokens | undefined;

      if (!legend || !tokens) return null;

      const results: IdentifierToken[] = [];
      const data = tokens.data;
      let line = 0;
      let char = 0;

      for (let i = 0; i < data.length; i += 5) {
        const deltaLine = data[i];
        const deltaChar = data[i + 1];
        const length = data[i + 2];
        const typeIdx = data[i + 3];

        line += deltaLine;
        char = deltaLine === 0 ? char + deltaChar : deltaChar;

        const tokenType = legend.tokenTypes[typeIdx];
        const role = roleFromSemanticTokenType(tokenType);
        if (role === 'unknown') continue;

        const text = document.getText(
          new vscode.Range(line, char, line, char + length)
        );
        const script = detectScript(text);
        if (script === 'en' || script === 'unknown') continue; // nothing to translate

        results.push({
          original: text,
          line,
          startChar: char,
          endChar: char + length,
          role,
          script,
        });
      }
      return results;
    } catch {
      return null; // language has no semantic tokens provider — caller falls back
    }
  }

  /**
   * Per-line heuristic: finds ranges that are inside a quoted string literal
   * ('...', "...", `...`) or a `//` line comment, so the regex fallback
   * scanner (used for languages without a semantic tokens provider) doesn't
   * mistake string/comment content for an identifier. This is line-based
   * only — it does not track multi-line block comments (`/* ... *\/`) or
   * multi-line strings, which is an acceptable gap for a fallback path
   * whose primary job is identifier names, not full lexing.
   */
  private static findExcludedRanges(line: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let i = 0;
    let quote: string | null = null;
    let stringStart = -1;

    while (i < line.length) {
      const ch = line[i];

      if (quote) {
        if (ch === '\\') {
          i += 2; // skip escaped character
          continue;
        }
        if (ch === quote) {
          ranges.push([stringStart, i + 1]);
          quote = null;
        }
        i++;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        stringStart = i;
        i++;
        continue;
      }

      if (ch === '/' && line[i + 1] === '/') {
        ranges.push([i, line.length]);
        break;
      }

      i++;
    }

    // Unterminated string (rare, e.g. mid-edit) — exclude to end of line
    // rather than risk scanning garbage as an identifier.
    if (quote) ranges.push([stringStart, line.length]);

    return ranges;
  }

  private static isExcluded(index: number, ranges: Array<[number, number]>): boolean {
    return ranges.some(([start, end]) => index >= start && index < end);
  }

  /** Fallback path for languages without a semantic tokens provider. */
  static scanViaRegex(document: vscode.TextDocument, range: vscode.Range): IdentifierToken[] {
    const results: IdentifierToken[] = [];

    for (let lineNo = range.start.line; lineNo <= range.end.line; lineNo++) {
      if (lineNo >= document.lineCount) break;
      const line = document.lineAt(lineNo).text;
      const excluded = this.findExcludedRanges(line);

      for (const match of line.matchAll(IDENTIFIER_RE)) {
        const text = match[0];
        if (KEYWORD_DENYLIST.has(text)) continue;

        const startChar = match.index ?? 0;
        if (this.isExcluded(startChar, excluded)) continue; // inside a string literal or // comment

        const script = detectScript(text);
        if (script === 'en' || script === 'unknown') continue;

        results.push({
          original: text,
          line: lineNo,
          startChar,
          endChar: startChar + text.length,
          role: inferRoleHeuristic(line, startChar, text),
          script,
        });
      }
    }
    return results;
  }

  static async scan(document: vscode.TextDocument, range: vscode.Range): Promise<IdentifierToken[]> {
    const viaSemantic = await this.scanViaSemanticTokens(document, range);
    return viaSemantic ?? this.scanViaRegex(document, range);
  }
}

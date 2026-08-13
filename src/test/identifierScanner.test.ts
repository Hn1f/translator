import * as assert from 'assert';
import { IdentifierScanner } from '../identifiers/IdentifierScanner';

// Minimal fake of the vscode.TextDocument surface used by scanViaRegex, so
// this test runs without spinning up the full extension host.
function fakeDocument(lines: string[]) {
  return {
    lineCount: lines.length,
    lineAt: (n: number) => ({ text: lines[n] }),
  } as any;
}

function fakeRange(startLine: number, endLine: number) {
  return { start: { line: startLine }, end: { line: endLine } } as any;
}

describe('IdentifierScanner.scanViaRegex', () => {
  it('finds a Chinese identifier and skips English ones', () => {
    const doc = fakeDocument(['int 用户数量 = 0;', 'int userCount = 0;']);
    const tokens = IdentifierScanner.scanViaRegex(doc, fakeRange(0, 1));

    const originals = tokens.map((t) => t.original);
    assert.ok(originals.includes('用户数量'));
    assert.ok(!originals.includes('userCount'));
    assert.ok(!originals.includes('int'), 'keyword should be denylisted');
  });

  it('infers class role from preceding "class" keyword', () => {
    const doc = fakeDocument(['class 机器人', '{']);
    const tokens = IdentifierScanner.scanViaRegex(doc, fakeRange(0, 1));
    const robot = tokens.find((t) => t.original === '机器人');
    assert.strictEqual(robot?.role, 'class');
  });

  it('classifies script correctly for Arabic and Cyrillic', () => {
    const doc = fakeDocument(['int متغير = 1;', 'int переменная = 2;']);
    const tokens = IdentifierScanner.scanViaRegex(doc, fakeRange(0, 1));
    assert.strictEqual(tokens.find((t) => t.original === 'متغير')?.script, 'ar');
    assert.strictEqual(tokens.find((t) => t.original === 'переменная')?.script, 'ru');
  });

  it('ignores non-Latin text inside a string literal', () => {
    // Regression: a Chinese string literal in a print/cout statement was
    // previously scanned as if it were an identifier, producing a garbled
    // overlapping decoration (translation rendered on top of untouched
    // original text) since the "identifier" wasn't a real symbol at all.
    const doc = fakeDocument(['std::cout << "温度正常。" << std::endl;']);
    const tokens = IdentifierScanner.scanViaRegex(doc, fakeRange(0, 0));
    assert.strictEqual(tokens.length, 0, 'string contents must not be treated as identifiers');
  });

  it('ignores non-Latin text inside a // comment', () => {
    const doc = fakeDocument(['int 计数 = 0; // 这是注释']);
    const tokens = IdentifierScanner.scanViaRegex(doc, fakeRange(0, 0));
    const originals = tokens.map((t) => t.original);
    assert.ok(originals.includes('计数'), 'real identifier before the comment should still be found');
    assert.ok(!originals.includes('这是注释'), 'comment content must not be treated as an identifier');
  });

  it('still finds an identifier that appears after a closed string literal on the same line', () => {
    const doc = fakeDocument(['print("你好"); int 计数 = 1;']);
    const tokens = IdentifierScanner.scanViaRegex(doc, fakeRange(0, 0));
    const originals = tokens.map((t) => t.original);
    assert.ok(!originals.includes('你好'));
    assert.ok(originals.includes('计数'));
  });
});

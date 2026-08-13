"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const IdentifierScanner_1 = require("../identifiers/IdentifierScanner");
// Minimal fake of the vscode.TextDocument surface used by scanViaRegex, so
// this test runs without spinning up the full extension host.
function fakeDocument(lines) {
    return {
        lineCount: lines.length,
        lineAt: (n) => ({ text: lines[n] }),
    };
}
function fakeRange(startLine, endLine) {
    return { start: { line: startLine }, end: { line: endLine } };
}
describe('IdentifierScanner.scanViaRegex', () => {
    it('finds a Chinese identifier and skips English ones', () => {
        const doc = fakeDocument(['int 用户数量 = 0;', 'int userCount = 0;']);
        const tokens = IdentifierScanner_1.IdentifierScanner.scanViaRegex(doc, fakeRange(0, 1));
        const originals = tokens.map((t) => t.original);
        assert.ok(originals.includes('用户数量'));
        assert.ok(!originals.includes('userCount'));
        assert.ok(!originals.includes('int'), 'keyword should be denylisted');
    });
    it('infers class role from preceding "class" keyword', () => {
        const doc = fakeDocument(['class 机器人', '{']);
        const tokens = IdentifierScanner_1.IdentifierScanner.scanViaRegex(doc, fakeRange(0, 1));
        const robot = tokens.find((t) => t.original === '机器人');
        assert.strictEqual(robot?.role, 'class');
    });
    it('classifies script correctly for Arabic and Cyrillic', () => {
        const doc = fakeDocument(['int متغير = 1;', 'int переменная = 2;']);
        const tokens = IdentifierScanner_1.IdentifierScanner.scanViaRegex(doc, fakeRange(0, 1));
        assert.strictEqual(tokens.find((t) => t.original === 'متغير')?.script, 'ar');
        assert.strictEqual(tokens.find((t) => t.original === 'переменная')?.script, 'ru');
    });
    it('ignores non-Latin text inside a string literal', () => {
        // Regression: a Chinese string literal in a print/cout statement was
        // previously scanned as if it were an identifier, producing a garbled
        // overlapping decoration (translation rendered on top of untouched
        // original text) since the "identifier" wasn't a real symbol at all.
        const doc = fakeDocument(['std::cout << "温度正常。" << std::endl;']);
        const tokens = IdentifierScanner_1.IdentifierScanner.scanViaRegex(doc, fakeRange(0, 0));
        assert.strictEqual(tokens.length, 0, 'string contents must not be treated as identifiers');
    });
    it('ignores non-Latin text inside a // comment', () => {
        const doc = fakeDocument(['int 计数 = 0; // 这是注释']);
        const tokens = IdentifierScanner_1.IdentifierScanner.scanViaRegex(doc, fakeRange(0, 0));
        const originals = tokens.map((t) => t.original);
        assert.ok(originals.includes('计数'), 'real identifier before the comment should still be found');
        assert.ok(!originals.includes('这是注释'), 'comment content must not be treated as an identifier');
    });
    it('still finds an identifier that appears after a closed string literal on the same line', () => {
        const doc = fakeDocument(['print("你好"); int 计数 = 1;']);
        const tokens = IdentifierScanner_1.IdentifierScanner.scanViaRegex(doc, fakeRange(0, 0));
        const originals = tokens.map((t) => t.original);
        assert.ok(!originals.includes('你好'));
        assert.ok(originals.includes('计数'));
    });
});
//# sourceMappingURL=identifierScanner.test.js.map
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
exports.DecorationController = void 0;
const vscode = __importStar(require("vscode"));
const IdentifierScanner_1 = require("../identifiers/IdentifierScanner");
const RepoIdentity_1 = require("../identifiers/RepoIdentity");
const logger_1 = require("../logger");
const VISIBLE_RANGE_PADDING_LINES = 20;
const SCROLL_DEBOUNCE_MS = 150;
/**
 * Owns the purely-visual translation layer. Never issues a WorkspaceEdit.
 * This is the component that makes the "file on disk is 100% unchanged"
 * and "Git detects zero modifications" requirements true by construction.
 */
class DecorationController {
    constructor(queue, getConfig) {
        this.queue = queue;
        this.getConfig = getConfig;
        this.states = new Map();
        this.disposables = [];
        this.disposables.push(vscode.window.onDidChangeVisibleTextEditors((editors) => this.onVisibleEditorsChanged(editors)), vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.scheduleRescan(e.textEditor)), vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)), vscode.window.onDidChangeTextEditorSelection((e) => this.onSelectionChanged(e)));
        for (const editor of vscode.window.visibleTextEditors) {
            if (!this.isScannable(editor.document))
                continue;
            this.ensureState(editor);
            this.scheduleRescan(editor);
        }
    }
    key(editor) {
        return editor.document.uri.toString();
    }
    ensureState(editor) {
        const k = this.key(editor);
        let state = this.states.get(k);
        if (!state) {
            state = {
                hideType: vscode.window.createTextEditorDecorationType({
                    // Free-form CSS passthrough hack (documented in ARCHITECTURE.md §6):
                    // collapses the original text to zero width without editing the buffer.
                    textDecoration: 'none; display: none;',
                }),
                showRanges: new Map(),
                scrollTimer: undefined,
            };
            this.states.set(k, state);
        }
        return state;
    }
    onVisibleEditorsChanged(editors) {
        const visibleKeys = new Set(editors.map((e) => e.document.uri.toString()));
        for (const [k, state] of this.states) {
            if (!visibleKeys.has(k)) {
                this.disposeState(state);
                this.states.delete(k);
            }
        }
        for (const editor of editors) {
            if (!this.isScannable(editor.document))
                continue;
            this.ensureState(editor);
            this.scheduleRescan(editor);
        }
    }
    /**
     * Only real files on disk are translation candidates. Without this guard,
     * VS Code's own Output/Log/Task panels (scheme 'output', 'vscode', etc.)
     * get treated as editors too — and since our own Output channel updates
     * itself every time we log, that would retrigger a scan on every log
     * line, which logs again, in a feedback loop. Caught via manual testing:
     * see conversation history for the "Scanned ... (Log): found 0" spam.
     */
    isScannable(document) {
        return document.uri.scheme === 'file';
    }
    scheduleRescan(editor) {
        if (!this.getConfig().enabled || !this.getConfig().automaticTranslation)
            return;
        if (!this.isScannable(editor.document))
            return;
        const state = this.ensureState(editor);
        if (state.scrollTimer)
            clearTimeout(state.scrollTimer);
        state.scrollTimer = setTimeout(() => {
            this.rescan(editor).catch((err) => {
                logger_1.Logger.error(`rescan() threw for ${editor.document.uri.fsPath}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            });
        }, SCROLL_DEBOUNCE_MS);
    }
    async rescan(editor) {
        const doc = editor.document;
        const visible = editor.visibleRanges[0];
        if (!visible) {
            logger_1.Logger.warn(`rescan skipped for ${doc.uri.fsPath}: no visible range.`);
            return;
        }
        const startLine = Math.max(0, visible.start.line - VISIBLE_RANGE_PADDING_LINES);
        const endLine = Math.min(doc.lineCount - 1, visible.end.line + VISIBLE_RANGE_PADDING_LINES);
        const range = new vscode.Range(startLine, 0, endLine, 0);
        const tokens = await IdentifierScanner_1.IdentifierScanner.scan(doc, range);
        logger_1.Logger.info(`Scanned ${doc.uri.fsPath} (${doc.languageId}): found ${tokens.length} candidate identifier(s).`);
        if (tokens.length === 0)
            return;
        const repoHash = RepoIdentity_1.RepoIdentity.hashForDocument(doc);
        const cacheHits = await this.queue.resolve(repoHash, doc.uri.fsPath, doc.languageId, tokens, (resolved) => {
            logger_1.Logger.info(`Model/fallback resolved ${resolved.size} identifier(s) for ${doc.uri.fsPath}.`);
            // Late arrivals from the model — paint incrementally once ready.
            this.applyResults(editor, tokens, resolved);
        });
        logger_1.Logger.info(`Cache hits: ${cacheHits.size}/${tokens.length} for ${doc.uri.fsPath} (repo ${repoHash}).`);
        this.applyResults(editor, tokens, cacheHits);
    }
    applyResults(editor, tokens, results) {
        if (results.size === 0)
            return;
        const state = this.ensureState(editor);
        const config = this.getConfig();
        const hideRanges = [];
        for (const token of tokens) {
            const key = `${token.original}::${token.role}`;
            const result = results.get(key);
            if (!result)
                continue;
            const range = new vscode.Range(token.line, token.startChar, token.line, token.endChar);
            const rangeKey = `${token.line}:${token.startChar}:${token.endChar}`;
            // Don't re-render a range the caret is currently inside (see onSelectionChanged).
            if (this.revealedRange && this.revealedRange.editor === editor && this.revealedRange.range.isEqual(range)) {
                continue;
            }
            const existing = state.showRanges.get(rangeKey);
            if (existing)
                existing.type.dispose();
            const color = result.confidence > 0 ? config.decorationColor : config.lowConfidenceColor;
            const showType = vscode.window.createTextEditorDecorationType({
                before: {
                    contentText: result.translated,
                    color,
                    fontStyle: result.confidence > 0 ? 'normal' : 'italic',
                },
            });
            editor.setDecorations(showType, [range]);
            state.showRanges.set(rangeKey, { type: showType, range, original: token.original });
            hideRanges.push(range);
        }
        if (hideRanges.length > 0) {
            const allHidden = [...state.showRanges.values()].map((v) => v.range);
            editor.setDecorations(state.hideType, allHidden);
        }
    }
    /**
     * When the caret enters a translated range, temporarily un-hide the
     * original text so the user can see and edit what's actually in the
     * buffer, rather than silently editing "through" invisible text. This is
     * the documented trade-off from ARCHITECTURE.md §6.
     */
    onSelectionChanged(e) {
        const editor = e.textEditor;
        const state = this.states.get(this.key(editor));
        if (!state)
            return;
        const caret = e.selections[0]?.active;
        if (!caret)
            return;
        let hit;
        for (const entry of state.showRanges.values()) {
            if (entry.range.contains(caret)) {
                hit = entry;
                break;
            }
        }
        // Restore previously revealed range (if caret moved away).
        if (this.revealedRange && (!hit || !this.revealedRange.range.isEqual(hit.range))) {
            const prevKey = `${this.revealedRange.range.start.line}:${this.revealedRange.range.start.character}:${this.revealedRange.range.end.character}`;
            const prevState = this.states.get(this.key(this.revealedRange.editor));
            const prevEntry = prevState?.showRanges.get(prevKey);
            if (prevEntry) {
                this.revealedRange.editor.setDecorations(state.hideType, [
                    ...prevState.showRanges.values(),
                ].map((v) => v.range));
            }
            this.revealedRange = undefined;
        }
        if (hit) {
            this.revealedRange = { editor, range: hit.range };
            const remainingHidden = [...state.showRanges.values()]
                .filter((v) => !v.range.isEqual(hit.range))
                .map((v) => v.range);
            editor.setDecorations(state.hideType, remainingHidden);
        }
    }
    onDocumentChanged(e) {
        // An edit invalidates any decoration ranges it overlaps; simplest
        // correct behavior is to re-scan the affected editor on the next
        // debounce tick rather than trying to patch ranges in place.
        const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === e.document);
        if (editor)
            this.scheduleRescan(editor);
    }
    disposeState(state) {
        state.hideType.dispose();
        for (const entry of state.showRanges.values())
            entry.type.dispose();
        if (state.scrollTimer)
            clearTimeout(state.scrollTimer);
    }
    dispose() {
        for (const state of this.states.values())
            this.disposeState(state);
        this.states.clear();
        for (const d of this.disposables)
            d.dispose();
    }
}
exports.DecorationController = DecorationController;
//# sourceMappingURL=DecorationController.js.map
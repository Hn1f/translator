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
exports.ConfigManager = void 0;
const vscode = __importStar(require("vscode"));
const SECTION = 'aiIdentifierTranslator';
/**
 * Thin, typed wrapper around workspace configuration. Centralizing this
 * avoids magic strings scattered across the codebase and gives every
 * consumer a single place to react to live settings changes.
 */
class ConfigManager {
    constructor() {
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeConfig = this._onDidChange.event;
        this.current = this.read();
        this.watcher = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(SECTION)) {
                this.current = this.read();
                this._onDidChange.fire(this.current);
            }
        });
    }
    get() {
        return this.current;
    }
    read() {
        const cfg = vscode.workspace.getConfiguration(SECTION);
        return {
            enabled: cfg.get('enabled', true),
            targetLanguage: cfg.get('targetLanguage', 'en'),
            model: cfg.get('model', 'qwen2.5:1.5b-instruct'),
            ollamaEndpoint: cfg.get('ollamaEndpoint', 'http://127.0.0.1:11434'),
            temperature: cfg.get('temperature', 0.1),
            maxContextTokens: cfg.get('maxContextTokens', 2048),
            automaticTranslation: cfg.get('automaticTranslation', true),
            maxConcurrentTranslations: cfg.get('maxConcurrentTranslations', 2),
            cacheLocation: cfg.get('cacheLocation', ''),
            decorationColor: cfg.get('decorationColor', '#6A9955'),
            lowConfidenceColor: cfg.get('lowConfidenceColor', '#CC6666'),
        };
    }
    dispose() {
        this.watcher.dispose();
        this._onDidChange.dispose();
    }
}
exports.ConfigManager = ConfigManager;
//# sourceMappingURL=ConfigManager.js.map
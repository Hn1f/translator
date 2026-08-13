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
exports.TranslationQueue = void 0;
const vscode = __importStar(require("vscode"));
const OllamaClient_1 = require("./OllamaClient");
const logger_1 = require("../logger");
/**
 * Coordinates cache lookups and (throttled) Ollama calls. Callers ask for a
 * batch of tokens; anything already cached resolves synchronously, anything
 * missing is queued and resolved asynchronously via the callback so the
 * DecorationController can incrementally paint results as they arrive
 * instead of blocking the whole file on one slow model call.
 */
class TranslationQueue {
    constructor(cacheRouter, client, maxConcurrent) {
        this.cacheRouter = cacheRouter;
        this.client = client;
        this.queue = [];
        this.inFlight = 0;
        this.maxConcurrent = maxConcurrent;
    }
    setMaxConcurrent(n) {
        this.maxConcurrent = n;
    }
    /**
     * Returns cached results, and asynchronously resolves the remainder via
     * `onResolved` once the model responds (or falls back). The whole method
     * is async because opening a repo's cache (sql.js) is itself async — see
     * CacheRouter.forRepo.
     */
    async resolve(repoHash, filePath, languageId, tokens, onResolved) {
        const cache = await this.cacheRouter.forRepo(repoHash);
        const cacheHits = new Map();
        const misses = [];
        const originals = tokens.map((t) => t.original);
        const bulk = cache.lookupMany(repoHash, originals);
        for (const token of tokens) {
            const key = `${token.original}::${token.role}`;
            const hit = bulk.get(key) ?? cache.lookup(repoHash, token.original, token.role) ?? undefined;
            if (hit) {
                cacheHits.set(key, hit);
            }
            else {
                misses.push(token);
            }
        }
        if (misses.length > 0) {
            this.queue.push({
                repoHash,
                filePath,
                languageId,
                tokens: misses,
                resolve: onResolved,
            });
            this.pump();
        }
        return cacheHits;
    }
    pump() {
        while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
            const job = this.queue.shift();
            this.inFlight++;
            this.runJob(job)
                .catch((err) => {
                logger_1.Logger.error(`runJob crashed for ${job.filePath}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            })
                .finally(() => {
                this.inFlight--;
                this.pump();
            });
        }
    }
    async runJob(job) {
        const uniqueByRole = new Map();
        for (const t of job.tokens)
            uniqueByRole.set(`${t.original}::${t.role}`, t);
        const uniqueTokens = [...uniqueByRole.values()];
        let translations;
        let confidence = 0.85;
        let modelName = 'ollama';
        try {
            logger_1.Logger.info(`Requesting Ollama translation for ${uniqueTokens.length} identifier(s) in ${job.filePath}...`);
            const batchResult = await this.client.translateBatch({
                repoHash: job.repoHash,
                filePath: job.filePath,
                languageId: job.languageId,
                identifiers: uniqueTokens.map((t) => ({ text: t.original, role: t.role })),
            });
            translations = batchResult;
            modelName = 'ollama';
            logger_1.Logger.info(`Ollama returned ${translations.size} translation(s) for ${job.filePath}.`);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger_1.Logger.error(`Ollama call failed for ${job.filePath}: ${message}. Falling back to placeholder names.`);
            if (err instanceof OllamaClient_1.OllamaTranslationError) {
                vscode.window.setStatusBarMessage(`AI Identifier Translator: falling back to placeholder names (${err.message})`, 5000);
            }
            else {
                vscode.window.setStatusBarMessage(`AI Identifier Translator: could not reach Ollama at the configured endpoint — using placeholder names.`, 5000);
            }
            translations = new Map();
            confidence = 0.0;
            modelName = 'fallback';
        }
        const results = new Map();
        const now = Date.now();
        for (const token of uniqueTokens) {
            const key = `${token.original}::${token.role}`;
            const translated = translations.get(token.original) ?? (0, OllamaClient_1.transliterationFallback)(token.original, token.role);
            const record = {
                original: token.original,
                translated,
                role: token.role,
                script: token.script,
                confidence: translations.has(token.original) ? confidence : 0.0,
                model: translations.has(token.original) ? modelName : 'fallback',
            };
            results.set(key, record);
            const cache = await this.cacheRouter.forRepo(job.repoHash);
            cache.upsert({ ...record, repoHash: job.repoHash, createdAt: now, updatedAt: now });
        }
        job.resolve(results);
    }
}
exports.TranslationQueue = TranslationQueue;
//# sourceMappingURL=TranslationQueue.js.map
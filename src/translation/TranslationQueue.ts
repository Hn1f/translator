import * as vscode from 'vscode';
import { CacheRouter } from '../cache/CacheManager';
import { IdentifierToken, TranslationResult } from '../types';
import { OllamaClient, OllamaTranslationError, transliterationFallback } from './OllamaClient';
import { Logger } from '../logger';

type ResolveCallback = (results: Map<string, TranslationResult>) => void;

interface PendingJob {
  repoHash: string;
  filePath: string;
  languageId: string;
  tokens: IdentifierToken[];
  resolve: ResolveCallback;
}

/**
 * Coordinates cache lookups and (throttled) Ollama calls. Callers ask for a
 * batch of tokens; anything already cached resolves synchronously, anything
 * missing is queued and resolved asynchronously via the callback so the
 * DecorationController can incrementally paint results as they arrive
 * instead of blocking the whole file on one slow model call.
 */
export class TranslationQueue {
  private queue: PendingJob[] = [];
  private inFlight = 0;
  private maxConcurrent: number;

  constructor(
    private cacheRouter: CacheRouter,
    private client: OllamaClient,
    maxConcurrent: number
  ) {
    this.maxConcurrent = maxConcurrent;
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n;
  }

  /**
   * Returns cached results, and asynchronously resolves the remainder via
   * `onResolved` once the model responds (or falls back). The whole method
   * is async because opening a repo's cache (sql.js) is itself async — see
   * CacheRouter.forRepo.
   */
  async resolve(
    repoHash: string,
    filePath: string,
    languageId: string,
    tokens: IdentifierToken[],
    onResolved: ResolveCallback
  ): Promise<Map<string, TranslationResult>> {
    const cache = await this.cacheRouter.forRepo(repoHash);
    const cacheHits = new Map<string, TranslationResult>();
    const misses: IdentifierToken[] = [];

    const originals = tokens.map((t) => t.original);
    const bulk = cache.lookupMany(repoHash, originals);

    for (const token of tokens) {
      const key = `${token.original}::${token.role}`;
      const hit = bulk.get(key) ?? cache.lookup(repoHash, token.original, token.role) ?? undefined;
      if (hit) {
        cacheHits.set(key, hit);
      } else {
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

  private pump(): void {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.inFlight++;
      this.runJob(job)
        .catch((err) => {
          Logger.error(
            `runJob crashed for ${job.filePath}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
          );
        })
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }

  private async runJob(job: PendingJob): Promise<void> {
    const uniqueByRole = new Map<string, IdentifierToken>();
    for (const t of job.tokens) uniqueByRole.set(`${t.original}::${t.role}`, t);
    const uniqueTokens = [...uniqueByRole.values()];

    let translations: Map<string, string>;
    let confidence = 0.85;
    let modelName = 'ollama';

    try {
      Logger.info(`Requesting Ollama translation for ${uniqueTokens.length} identifier(s) in ${job.filePath}...`);
      const batchResult = await this.client.translateBatch({
        repoHash: job.repoHash,
        filePath: job.filePath,
        languageId: job.languageId,
        identifiers: uniqueTokens.map((t) => ({ text: t.original, role: t.role })),
      });
      translations = batchResult;
      modelName = 'ollama';
      Logger.info(`Ollama returned ${translations.size} translation(s) for ${job.filePath}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Logger.error(`Ollama call failed for ${job.filePath}: ${message}. Falling back to placeholder names.`);
      if (err instanceof OllamaTranslationError) {
        vscode.window.setStatusBarMessage(
          `AI Identifier Translator: falling back to placeholder names (${err.message})`,
          5000
        );
      } else {
        vscode.window.setStatusBarMessage(
          `AI Identifier Translator: could not reach Ollama at the configured endpoint — using placeholder names.`,
          5000
        );
      }
      translations = new Map();
      confidence = 0.0;
      modelName = 'fallback';
    }

    const results = new Map<string, TranslationResult>();
    const now = Date.now();

    for (const token of uniqueTokens) {
      const key = `${token.original}::${token.role}`;
      const translated = translations.get(token.original) ?? transliterationFallback(token.original, token.role);
      const record: TranslationResult = {
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

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import { CacheRecord, IdentifierRole, TranslationResult } from '../types';
import { isValidTranslation } from '../translation/validation';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS identifiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_hash   TEXT NOT NULL,
  original    TEXT NOT NULL,
  translated  TEXT NOT NULL,
  language    TEXT NOT NULL,
  role        TEXT NOT NULL,
  confidence  REAL NOT NULL,
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(repo_hash, original, role)
);
CREATE INDEX IF NOT EXISTS idx_lookup ON identifiers(repo_hash, original);

CREATE TABLE IF NOT EXISTS glossary_overrides (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_hash   TEXT NOT NULL,
  original    TEXT NOT NULL,
  translated  TEXT NOT NULL,
  role        TEXT NOT NULL,
  author      TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(repo_hash, original, role)
);
`;

const SAVE_DEBOUNCE_MS = 250;

// sql.js's WASM binary only needs loading once per extension host process,
// regardless of how many repos/CacheManagers get opened.
let sqlJsPromise: Promise<SqlJsStatic> | undefined;

function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      // Compiled output lives in out/cache/CacheManager.js — walk back up to
      // the extension root to find the wasm binary shipped alongside the
      // sql.js dependency. vsce includes `dependencies` (not devDependencies)
      // in the packaged .vsix by default, so this file travels with the install.
      locateFile: (file: string) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
    });
  }
  return sqlJsPromise as Promise<SqlJsStatic>;
}

/**
 * Per-repository SQLite cache, backed by sql.js (SQLite compiled to
 * WebAssembly). Deliberately NOT using a native addon (e.g. better-sqlite3):
 * native addons must be compiled against the exact Node ABI of the process
 * that loads them, and the VS Code extension host runs on Electron's
 * bundled Node — not the developer's system Node used by `npm install`.
 * That mismatch is a well-known source of "NODE_MODULE_VERSION" crashes for
 * VS Code extensions. sql.js sidesteps this entirely: same WASM binary runs
 * identically in plain Node and inside the extension host.
 *
 * Trade-off: sql.js keeps the whole database in memory and writes it back
 * to disk explicitly (there's no native file-backed journal). We debounce
 * that write on each mutation so a burst of upserts triggers one disk write,
 * not one per row.
 */
export class CacheManager {
  private saveTimer: NodeJS.Timeout | undefined;

  private constructor(
    private db: SqlJsDatabase,
    private dbPath: string
  ) {}

  static async open(cacheDir: string, repoHash: string): Promise<CacheManager> {
    fs.mkdirSync(cacheDir, { recursive: true });
    const dbPath = path.join(cacheDir, `${repoHash}.db`);
    const SQL = await getSqlJs();

    const db = fs.existsSync(dbPath)
      ? new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)))
      : new SQL.Database();

    db.exec(SCHEMA);
    return new CacheManager(db, dbPath);
  }

  lookup(repoHash: string, original: string, role: IdentifierRole): TranslationResult | null {
    const override = this.queryOne(
      `SELECT original, translated, role, 'override' as script, 1.0 as confidence, 'glossary' as model
       FROM glossary_overrides WHERE repo_hash = ? AND original = ? AND role = ?`,
      [repoHash, original, role]
    );
    if (override) return override as unknown as TranslationResult;

    const row = this.queryOne(
      // confidence > 0 excludes stale fallback (id_xxxxx placeholder) entries —
      // a fallback wasn't a real translation, so it must never count as a
      // permanent cache hit that blocks retrying against Ollama later.
      `SELECT original, translated, role, language as script, confidence, model
       FROM identifiers WHERE repo_hash = ? AND original = ? AND role = ? AND confidence > 0`,
      [repoHash, original, role]
    );
    if (!row) return null;

    // Revalidate on read: rows written before the English-only check
    // existed (or by any future code path that skips validation) must not
    // resurface a non-English "translation" as if it were a permanent hit.
    const result = row as unknown as TranslationResult;
    return isValidTranslation(result.translated) ? result : null;
  }

  lookupMany(repoHash: string, originals: string[]): Map<string, TranslationResult> {
    const map = new Map<string, TranslationResult>();
    if (originals.length === 0) return map;

    const placeholders = originals.map(() => '?').join(',');
    const rows = this.queryAll(
      // See lookup() above: confidence > 0 excludes stale fallback entries.
      `SELECT original, translated, role, language as script, confidence, model
       FROM identifiers WHERE repo_hash = ? AND original IN (${placeholders}) AND confidence > 0`,
      [repoHash, ...originals]
    );
    for (const r of rows) {
      const result = r as unknown as TranslationResult;
      if (isValidTranslation(result.translated)) {
        map.set(`${result.original}::${result.role}`, result);
      }
    }
    return map;
  }

  upsert(record: CacheRecord): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO identifiers (repo_hash, original, translated, language, role, confidence, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_hash, original, role) DO UPDATE SET
         translated = excluded.translated,
         confidence = excluded.confidence,
         model = excluded.model,
         updated_at = excluded.updated_at`,
      [
        record.repoHash,
        record.original,
        record.translated,
        record.script,
        record.role,
        record.confidence,
        record.model,
        record.createdAt ?? now,
        now,
      ]
    );
    this.scheduleSave();
  }

  clearRepo(repoHash: string): number {
    const before = this.queryOne(`SELECT COUNT(*) as c FROM identifiers WHERE repo_hash = ?`, [repoHash]);
    const count = before ? Number((before as unknown as { c: number }).c) : 0;
    this.db.run(`DELETE FROM identifiers WHERE repo_hash = ?`, [repoHash]);
    this.scheduleSave();
    return count;
  }

  exportGlossary(repoHash: string): { original: string; translated: string; role: string }[] {
    return this.queryAll(
      `SELECT original, translated, role FROM identifiers WHERE repo_hash = ? AND confidence >= 0.7`,
      [repoHash]
    ) as unknown as { original: string; translated: string; role: string }[];
  }

  /** Flushes any pending debounced write immediately — call before dispose. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.writeToDisk();
  }

  dispose(): void {
    this.flush();
    this.db.close();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeToDisk(), SAVE_DEBOUNCE_MS);
  }

  private writeToDisk(): void {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  private queryOne(sql: string, params: (string | number)[]): Record<string, unknown> | null {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const hasRow = stmt.step();
    const result = hasRow ? stmt.getAsObject() : null;
    stmt.free();
    return result;
  }

  private queryAll(sql: string, params: (string | number)[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
}

/**
 * Routes reads/writes to the correct per-repository database. A workspace
 * can have multiple repos open (multi-root workspaces, or scanning files
 * outside the active repo), so callers resolve one CacheManager per
 * repoHash from this router and everything stays repo-isolated.
 *
 * `forRepo` is async (unlike the old synchronous better-sqlite3 version)
 * because opening a repo's cache now means reading its file into an
 * in-memory sql.js database. In-flight opens for the same repo are
 * deduped via `opening`, so concurrent callers don't race to open the
 * same file twice.
 */
export class CacheRouter implements vscode.Disposable {
  private managers = new Map<string, CacheManager>();
  private opening = new Map<string, Promise<CacheManager>>();

  constructor(private cacheDir: string) {}

  setCacheDir(dir: string): void {
    if (dir === this.cacheDir) return;
    this.cacheDir = dir;
    for (const m of this.managers.values()) m.dispose();
    this.managers.clear();
    this.opening.clear();
  }

  async forRepo(repoHash: string): Promise<CacheManager> {
    const existing = this.managers.get(repoHash);
    if (existing) return existing;

    const inFlight = this.opening.get(repoHash);
    if (inFlight) return inFlight;

    const openPromise = CacheManager.open(this.cacheDir, repoHash).then((mgr) => {
      this.managers.set(repoHash, mgr);
      this.opening.delete(repoHash);
      return mgr;
    });
    this.opening.set(repoHash, openPromise);
    return openPromise;
  }

  dispose(): void {
    for (const m of this.managers.values()) m.dispose();
    this.managers.clear();
    this.opening.clear();
  }
}

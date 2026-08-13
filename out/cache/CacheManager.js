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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CacheRouter = exports.CacheManager = void 0;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const sql_js_1 = __importDefault(require("sql.js"));
const validation_1 = require("../translation/validation");
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
let sqlJsPromise;
function getSqlJs() {
    if (!sqlJsPromise) {
        sqlJsPromise = (0, sql_js_1.default)({
            // Compiled output lives in out/cache/CacheManager.js — walk back up to
            // the extension root to find the wasm binary shipped alongside the
            // sql.js dependency. vsce includes `dependencies` (not devDependencies)
            // in the packaged .vsix by default, so this file travels with the install.
            locateFile: (file) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
        });
    }
    return sqlJsPromise;
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
class CacheManager {
    constructor(db, dbPath) {
        this.db = db;
        this.dbPath = dbPath;
    }
    static async open(cacheDir, repoHash) {
        fs.mkdirSync(cacheDir, { recursive: true });
        const dbPath = path.join(cacheDir, `${repoHash}.db`);
        const SQL = await getSqlJs();
        const db = fs.existsSync(dbPath)
            ? new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)))
            : new SQL.Database();
        db.exec(SCHEMA);
        return new CacheManager(db, dbPath);
    }
    lookup(repoHash, original, role) {
        const override = this.queryOne(`SELECT original, translated, role, 'override' as script, 1.0 as confidence, 'glossary' as model
       FROM glossary_overrides WHERE repo_hash = ? AND original = ? AND role = ?`, [repoHash, original, role]);
        if (override)
            return override;
        const row = this.queryOne(
        // confidence > 0 excludes stale fallback (id_xxxxx placeholder) entries —
        // a fallback wasn't a real translation, so it must never count as a
        // permanent cache hit that blocks retrying against Ollama later.
        `SELECT original, translated, role, language as script, confidence, model
       FROM identifiers WHERE repo_hash = ? AND original = ? AND role = ? AND confidence > 0`, [repoHash, original, role]);
        if (!row)
            return null;
        // Revalidate on read: rows written before the English-only check
        // existed (or by any future code path that skips validation) must not
        // resurface a non-English "translation" as if it were a permanent hit.
        const result = row;
        return (0, validation_1.isValidTranslation)(result.translated) ? result : null;
    }
    lookupMany(repoHash, originals) {
        const map = new Map();
        if (originals.length === 0)
            return map;
        const placeholders = originals.map(() => '?').join(',');
        const rows = this.queryAll(
        // See lookup() above: confidence > 0 excludes stale fallback entries.
        `SELECT original, translated, role, language as script, confidence, model
       FROM identifiers WHERE repo_hash = ? AND original IN (${placeholders}) AND confidence > 0`, [repoHash, ...originals]);
        for (const r of rows) {
            const result = r;
            if ((0, validation_1.isValidTranslation)(result.translated)) {
                map.set(`${result.original}::${result.role}`, result);
            }
        }
        return map;
    }
    upsert(record) {
        const now = Date.now();
        this.db.run(`INSERT INTO identifiers (repo_hash, original, translated, language, role, confidence, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_hash, original, role) DO UPDATE SET
         translated = excluded.translated,
         confidence = excluded.confidence,
         model = excluded.model,
         updated_at = excluded.updated_at`, [
            record.repoHash,
            record.original,
            record.translated,
            record.script,
            record.role,
            record.confidence,
            record.model,
            record.createdAt ?? now,
            now,
        ]);
        this.scheduleSave();
    }
    clearRepo(repoHash) {
        const before = this.queryOne(`SELECT COUNT(*) as c FROM identifiers WHERE repo_hash = ?`, [repoHash]);
        const count = before ? Number(before.c) : 0;
        this.db.run(`DELETE FROM identifiers WHERE repo_hash = ?`, [repoHash]);
        this.scheduleSave();
        return count;
    }
    exportGlossary(repoHash) {
        return this.queryAll(`SELECT original, translated, role FROM identifiers WHERE repo_hash = ? AND confidence >= 0.7`, [repoHash]);
    }
    /** Flushes any pending debounced write immediately — call before dispose. */
    flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        this.writeToDisk();
    }
    dispose() {
        this.flush();
        this.db.close();
    }
    scheduleSave() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.writeToDisk(), SAVE_DEBOUNCE_MS);
    }
    writeToDisk() {
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
    }
    queryOne(sql, params) {
        const stmt = this.db.prepare(sql);
        stmt.bind(params);
        const hasRow = stmt.step();
        const result = hasRow ? stmt.getAsObject() : null;
        stmt.free();
        return result;
    }
    queryAll(sql, params) {
        const stmt = this.db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step())
            rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
    }
}
exports.CacheManager = CacheManager;
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
class CacheRouter {
    constructor(cacheDir) {
        this.cacheDir = cacheDir;
        this.managers = new Map();
        this.opening = new Map();
    }
    setCacheDir(dir) {
        if (dir === this.cacheDir)
            return;
        this.cacheDir = dir;
        for (const m of this.managers.values())
            m.dispose();
        this.managers.clear();
        this.opening.clear();
    }
    async forRepo(repoHash) {
        const existing = this.managers.get(repoHash);
        if (existing)
            return existing;
        const inFlight = this.opening.get(repoHash);
        if (inFlight)
            return inFlight;
        const openPromise = CacheManager.open(this.cacheDir, repoHash).then((mgr) => {
            this.managers.set(repoHash, mgr);
            this.opening.delete(repoHash);
            return mgr;
        });
        this.opening.set(repoHash, openPromise);
        return openPromise;
    }
    dispose() {
        for (const m of this.managers.values())
            m.dispose();
        this.managers.clear();
        this.opening.clear();
    }
}
exports.CacheRouter = CacheRouter;
//# sourceMappingURL=CacheManager.js.map
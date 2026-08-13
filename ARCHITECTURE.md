# AI Code Identifier Translator — Architecture

## 0. Honest scoping (read this first)

The spec asks for two things that are in tension with each other, and I want
to be upfront about the trade-off before you invest in a direction:

1. **Fully invisible virtual display** (translated identifiers rendered as if
   they were the real text, non-editor-breaking).
2. **Fully invisible round-trip editing** (user types `userCount`, buffer
   silently contains `用户数量`, and every VS Code subsystem — LSP,
   IntelliSense, semantic tokens, multi-cursor, undo, git blame gutter,
   minimap, find/replace, embedded terminals piping the buffer — treats the
   hidden write-back as if nothing happened).

(1) is solvable cleanly with VS Code's public API. (2) is **not** solvable
cleanly — there is no official "swap the underlying text but keep everything
else working" primitive. Every extension that has attempted this (Prettier's
"hide semicolons" experiments, several transliteration tools) ends up with
edge cases: multi-cursor, IME composition, autocomplete accept, "Rename
Symbol", git diff view, and the debugger's variable inspector all read/write
the *real* buffer directly, bypassing decorations entirely.

So this architecture ships in two phases:

- **Phase 1 (this deliverable): Read-side translation.** Fully working,
  production-quality. Original identifiers are decorated in-place so they
  *display* as English, LSP/semantic tokens/hover/go-to-def continue working
  untouched because we never touch the document. This alone solves 90% of
  the stated pain point (reading unfamiliar-script code).
- **Phase 2 (roadmap, not implemented here): Write-side assist.** Instead of
  silent byte-for-byte swapping (unreliable), we implement it as an
  **IntelliSense-integrated rename-insert**: user types the English name,
  extension offers a completion item / code action that inserts the
  *original* identifier (like a smart snippet), with the English name kept
  visible only via decoration afterward. This gets you 95% of the UX benefit
  of (2) without fighting the editor's core text model. A true invisible
  round-trip is listed as an explicit R&D spike in section 8.

If you want me to instead attempt the risky invisible-round-trip approach
(virtual `TextDocumentContentProvider` overlay + diff-based sync back to the
real file on save), I can scaffold that as an experimental mode — but it
should not be the thing you demo first, and it should not be default-enabled
on real projects. Flagging this now so it's your call, not a silent scope cut.

---

## 1. High-level architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          VS Code Extension Host                      │
│                                                                       │
│  ┌───────────────┐   ┌──────────────────┐   ┌──────────────────┐    │
│  │ IdentifierScan │──▶│ TranslationQueue  │──▶│  DecorationCtrl   │    │
│  │ (per open doc, │   │ (dedupe, batch,   │   │ (applies virtual  │    │
│  │  visible range │   │  priority = view- │   │  text via         │    │
│  │  only)         │   │  port distance)   │   │  TextEditorDeco-  │    │
│  └───────┬───────┘   └────────┬─────────┘   │  rationType)      │    │
│          │                    │              └──────────────────┘    │
│          │                    ▼                                      │
│          │           ┌──────────────────┐                            │
│          │           │   CacheManager    │◀──────┐                   │
│          │           │  (SQLite, keyed   │        │                   │
│          │           │  by repo hash)    │        │                   │
│          │           └────────┬─────────┘        │                   │
│          │                    │ cache miss        │ cache hit         │
│          │                    ▼                    │                   │
│          │           ┌──────────────────┐        │                   │
│          │           │  OllamaClient     │────────┘                   │
│          │           │ (local HTTP,      │                            │
│          │           │  /api/generate)   │                            │
│          │           └──────────────────┘                            │
│          │                                                            │
│          ▼                                                            │
│  ┌───────────────┐                                                    │
│  │ ConfigManager  │  (reads workspace + user settings)                │
│  └───────────────┘                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Key invariant: the extension never calls `TextEdit` / `WorkspaceEdit` on
the real document in Phase 1.** All "translation" is purely visual
(decorations). This is what guarantees:
- Git detects zero modifications (correct — we never write to disk).
- LSP, semantic highlighting, hover, go-to-def, references, rename-symbol,
  diagnostics all continue working untouched, because the document the
  language server sees is byte-identical to the document on disk, always.

## 2. Module responsibilities

| Module | Responsibility |
|---|---|
| `IdentifierScanner` | Given a document + visible range, extract candidate identifier tokens using Tree-sitter-lite regex per language (see §3), tagged with script (CJK/Arabic/Cyrillic/Latin) and syntactic role (best-effort: variable/function/class/const) from local heuristics (casing, preceding keyword). |
| `TranslationQueue` | Dedupes identical `(repoHash, identifier)` requests in flight, batches by file for context-aware prompts, prioritizes tokens nearest the visible viewport, throttles concurrent Ollama calls (default 2). |
| `CacheManager` | SQLite (`better-sqlite3`) wrapper. One DB file per repo (see §4). Read is synchronous+fast (in-memory LRU on top). Write is async, fire-and-forget. |
| `OllamaClient` | Thin HTTP client against local Ollama (`/api/generate`, `/api/chat`), JSON-mode prompting, response schema validation, retry-once-on-malformed-JSON. |
| `DecorationController` | Owns one `TextEditorDecorationType` per translated token category. Applies/clears decorations on `onDidChangeVisibleTextEditors`, `onDidChangeTextEditorVisibleRanges` (scroll), `onDidChangeTextDocument` (edits invalidate overlapping decorations only — not full re-scan). |
| `ConfigManager` | Typed wrapper over `workspace.getConfiguration('aiIdentifierTranslator')`, watches for changes, exposes `onDidChangeConfig`. |
| `RepoIdentity` | Computes stable repo hash: `git rev-parse --show-toplevel` → hash of that absolute path (not remote URL, so it works offline and for repos without a remote). Falls back to workspace folder path hash if not a git repo. |

## 3. Identifier scanning strategy

We do **not** implement a full parser per language (16 languages × real
grammars is a multi-month effort and duplicates what the LSP already knows).
Instead:

1. Use VS Code's own **semantic tokens** (`vscode.languages.getTokenTypes` /
   `provideDocumentSemanticTokens` from the already-active language server)
   to get authoritative `variable` / `function` / `class` / `parameter`
   token ranges — this is free, accurate, and per-language for anything with
   an LSP installed (which covers all 16 listed languages).
2. For each semantic token range, check if the text contains non-Latin
   script characters (Unicode script detection via `\p{Script=Han}`,
   `\p{Script=Arabic}`, `\p{Script=Hangul}`, `\p{Script=Cyrillic}` regex
   classes). Only those become translation candidates.
3. Fallback (no semantic tokens provider available for that language): regex
   tokenizer matching identifier grammar (`[\p{L}_][\p{L}\p{N}_]*`) minus a
   per-language keyword denylist.

This means Phase 1 rides on the LSP for correctness instead of
re-implementing it — directly satisfying the "must not break LSP integration"
requirement, because we are *consuming* the LSP's own output rather than
fighting it.

## 4. Cache schema (SQLite, one file per repo under `<cacheDir>/<repoHash>.db`)

```sql
CREATE TABLE IF NOT EXISTS identifiers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_hash       TEXT NOT NULL,
  original        TEXT NOT NULL,
  translated      TEXT NOT NULL,
  language        TEXT NOT NULL,       -- source script: zh, ja, ar, ko, ru, en
  role            TEXT,                -- variable | function | class | constant | namespace | unknown
  confidence      REAL NOT NULL,
  model           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(repo_hash, original, role)
);
CREATE INDEX IF NOT EXISTS idx_lookup ON identifiers(repo_hash, original);
```

`role` is part of the uniqueness key because the same source token can be a
class in one place and a variable in another with different English
conventions (PascalCase vs camelCase) — this matches requirement §4/§6.

## 5. Ollama prompt contract

System prompt enforces **strict JSON-only output**, one call per file (not
per-identifier) to give the model class-level context, e.g.:

```
Input identifiers (with role) from this file:
  class 用户管理器
  method 更新位置
  field 用户数量

Return ONLY minified JSON: {"用户管理器":"UserManager","更新位置":"updatePosition","用户数量":"userCount"}
Rules: variables/methods -> camelCase, classes -> PascalCase,
constants -> UPPER_CASE, namespaces -> lowercase. No explanations.
```

`OllamaClient` validates the response is valid JSON with exactly the
requested keys; on failure it retries once with a stricter reminder, then
falls back to a deterministic transliteration (pinyin/romaji library) tagged
with `confidence: 0.0` so the user can visually tell it's a fallback (configurable
color).

## 6. Decoration mechanics (the actual "virtual replace" trick)

VS Code has no official "replace displayed text" API. The standard
community-proven technique (used by e.g. inline-fold style extensions):

```ts
const hideOriginal = window.createTextEditorDecorationType({
  textDecoration: 'none; display: none;', // CSS injection via the free-form textDecoration field
});
const showTranslated = window.createTextEditorDecorationType({
  before: { contentText: '', color: themeColor }, // set per-range via `renderOptions.before.contentText`
});
```

For each candidate range: apply `hideOriginal` to the exact range, and apply
`showTranslated` with `renderOptions.before.contentText = translatedName` at
the same range's start. Net visual effect: the CJK/Arabic text collapses to
zero width and the English name renders in its place. This is a hack against
undocumented CSS passthrough, so:
- It's flagged in `KNOWN_LIMITATIONS.md` (below) as fragile across VS Code
  versions — must be smoke-tested on each VS Code minor release.
- It never touches the buffer, so copy-paste, find/replace, and the LSP see
  the real text — only the render layer is affected.
- Multi-cursor editing **inside** a hidden range is the sharp edge: we detect
  cursor entry into a hidden range (`onDidChangeTextEditorSelection`) and
  temporarily un-hide that one occurrence (revert to real text) so the user
  can see what they're actually editing — this avoids "invisible cursor"
  confusion, at the cost of the identifier "popping back" to original script
  while the caret is inside it. This is called out explicitly to set correct
  expectations.

## 7. Performance model

- Scan only `editor.visibleRanges` (+ a 20-line buffer above/below) on
  `onDidChangeTextEditorVisibleRanges`, debounced 150ms.
- Never scan closed/background files.
- SQLite reads are synchronous and sub-millisecond for cache hits; only
  cache misses touch Ollama (async, non-blocking, queued).
- Ollama concurrency capped (config: `maxConcurrentTranslations`, default 2)
  to avoid saturating CPU on the 1–1.5B local models.

## 8. Phase 2 roadmap (not implemented in this deliverable)

1. **Smart-insert editing** (recommended first step): register a
   `CompletionItemProvider` that, alongside the LSP's own suggestions, offers
   entries showing the English name but inserting the original identifier
   text — with an `insertText` that is the *original* script and a `label`
   that is the translated name. Zero buffer-hacking required; this is 100%
   within supported API.
2. **Experimental invisible round-trip** (R&D spike, opt-in flag
   `experimentalBidirectionalEdit`): maintain a virtual mirrored document via
   `TextDocumentContentProvider`, diff user edits against it, and translate
   the diff back into a `WorkspaceEdit` against the real file before it's
   applied. High complexity, needs a dedicated design doc and a multi-week
   spike before committing to it.
3. Team dictionaries / company glossary: additional SQLite table
   `glossary_overrides(repo_hash, original, translated, role, author)` that
   takes precedence over model output; sync via a JSON export/import command
   (`aiIdentifierTranslator.exportGlossary`) so teams can commit a shared
   glossary file to the repo without leaking full identifier caches.
4. GitHub Copilot / JetBrains / Neovim ports: the `CacheManager` + prompt
   contract are host-agnostic by design (no VS Code API used) specifically
   so they can be reused as a shared core package (`@ait/core`) later.

## 9. Folder structure delivered

```
ai-identifier-translator/
├── package.json
├── tsconfig.json
├── ARCHITECTURE.md          (this file)
├── KNOWN_LIMITATIONS.md
├── README.md
└── src/
    ├── extension.ts          (activation entrypoint)
    ├── types.ts
    ├── config/ConfigManager.ts
    ├── cache/CacheManager.ts
    ├── identifiers/IdentifierScanner.ts
    ├── identifiers/RepoIdentity.ts
    ├── translation/OllamaClient.ts
    ├── translation/TranslationQueue.ts
    ├── decorations/DecorationController.ts
    └── test/*.test.ts
```

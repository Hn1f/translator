# Known Limitations (Phase 1 — read-side translation)

Read this before demoing or shipping. None of these are secret — they're the
direct consequence of using undocumented decoration behavior instead of a
real "replace displayed text" API, which doesn't exist in VS Code.

1. **`textDecoration: 'none; display: none;'` is a CSS-injection hack**, not
   a documented API. It works today (tested against 1.85–1.9x) because VS
   Code passes the `textDecoration` string mostly unsanitized into the DOM.
   A future VS Code release could sanitize this and silently break the
   "hide original" half of the trick. Mitigation: `DecorationController`
   isolates this into one call site (`ensureState`), and the repo ships a
   smoke test to run against each new VS Code minor before upgrading the
   `engines.vscode` floor.

2. **Multi-cursor editing across multiple hidden ranges** is only handled
   for the primary caret (`e.selections[0]`). Secondary carets inside other
   hidden ranges will not auto-reveal. This is a deliberate MVP cut, not an
   oversight — tracked as a follow-up.

3. **IME composition** (typing Chinese/Japanese/Korean via an input method)
   while a caret sits inside a temporarily-revealed range is not
   specifically tested. Standard IME composition should work since we don't
   intercept keystrokes, but hasn't been validated against all platform IMEs.

4. **Undo/redo** operates on the real buffer as normal — decorations are not
   part of undo history, so undoing an edit near a translated range simply
   triggers a rescan on the next debounce tick. No special handling needed,
   but rapid undo/redo spam can cause visible "flicker" while rescans catch up.

5. **Minimap and breadcrumbs** still show the original script (they render
   from the raw buffer, independent of editor decorations). This is
   expected and consistent with "the file is 100% unchanged."

6. **Find/Replace (Ctrl+F) searches the real text**, not the translated
   display. Searching for `userCount` will not find `用户数量`. A
   `revealOriginal`-style "search by translated name" command is listed as
   a Phase 2 nice-to-have, implementable via a `QuickPick` over the cache
   table without touching Find/Replace internals.

7. **Semantic-token-based scanning depends on the installed language
   server** for that file type actually supporting range semantic tokens.
   Not all language servers do (varies by extension quality). The regex
   fallback (`scanViaRegex`) covers this gap but with weaker role inference
   (heuristic, not AST-based) — expect occasional camelCase/PascalCase
   convention misses on the fallback path specifically.

8. **No write-side (editing) support in this deliverable.** See
   `ARCHITECTURE.md` §8 for the Phase 2 plan and why silent byte-swapping
   on keystroke was deliberately not attempted as the first cut.

9. **Cache backend is sql.js (WASM), not a native SQLite binding.** This
   was a deliberate choice, not a fallback: a native addon like
   `better-sqlite3` must be compiled against the exact Node ABI of the
   process loading it, and the VS Code extension host runs Electron's
   bundled Node — not your system Node used by `npm install`. That mismatch
   reliably produces `NODE_MODULE_VERSION` crashes the first time the
   extension actually activates inside VS Code, even after a successful
   `npm install`. sql.js avoids this class of bug entirely at the cost of
   keeping each repo's cache DB in memory and writing it back to disk on a
   250ms debounce after each write (see `CacheManager.scheduleSave`) rather
   than journaling directly to disk. For the cache sizes this extension
   produces (identifier strings, not large blobs), this is not a
   performance concern in practice.

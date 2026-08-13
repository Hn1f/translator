# AI Code Identifier Translator

**Stop context-switching just to read a variable name.**

If you've ever opened a file and hit a wall of `用户数量`, `مدير_الإعدادات`,
or `текущаяПопытка`, you know the drill — alt-tab to a translator, copy the
identifier, paste, alt-tab back, repeat for every symbol in the file. This
extension does that step for you, live, inline, as you scroll.

🌐 **Chinese, Japanese, Korean, Arabic, and Russian identifiers** are shown
as English right in the editor — `机器人控制器` reads as `RobotController`,
`当前坐标X` reads as `currentCoordinateX`.

🔒 **Your file never changes.** Not one byte. Translation is a pure visual
overlay (VS Code decorations) on top of the real text — `git diff` stays
empty, and moving your cursor onto a translated name instantly reveals the
original underneath.

🖥️ **100% local.** Every translation runs through [Ollama](https://ollama.com)
on your machine. No API key, no cloud call, no code ever leaves your
computer.

⚡ **Fast after the first pass.** Translations are cached per-repository, so
reopening a file you've already scanned is instant.

---

> **Status:** this is Phase 1 — read-side, decoration-based display. Editing
> support (typing the English name and having it write back the original
> script) is on the roadmap but not yet implemented; see `ARCHITECTURE.md`
> §8 for the design and why it's a separate phase, and `KNOWN_LIMITATIONS.md`
> for the current honest list of rough edges.

## Requirements

- VS Code ^1.85.0
- Node.js 18+ (for building — no Python or C++ build tools needed; the
  SQLite cache runs on `sql.js`, a WebAssembly build, so there's no native
  module compilation step)
- [Ollama](https://ollama.com) running locally, with a small instruct model pulled:
  ```bash
  ollama pull qwen2.5:1.5b-instruct
  # alternatives: gemma3:1b, llama3.2:1b
  ```

## Build & run from source

```bash
git clone <this-repo>
cd ai-identifier-translator
npm install
npm run compile
```

Then in VS Code: `F5` (or Run → Start Debugging) to launch an Extension
Development Host with the extension loaded.

## Package for local install

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension ai-identifier-translator-0.1.0.vsix
```

## Usage

1. Make sure Ollama is running (`ollama serve`, or it's already running as a
   background service).
2. Open a file containing non-English identifiers.
3. Translation happens automatically for the visible portion of the file
   (toggle via `AI Identifier Translator: Toggle Translation` in the command
   palette, or `aiIdentifierTranslator.enabled` setting).
4. Move your cursor onto a translated (English-displayed) identifier to
   temporarily reveal the real, original text underneath.
5. `AI Identifier Translator: Clear Cache for This Repository` if you want
   to force retranslation (e.g. after switching models).

## Settings

See `package.json` → `contributes.configuration` for the full list
(`aiIdentifierTranslator.*`): target language, model, Ollama endpoint,
temperature, concurrency limit, cache location, and decoration colors.

## Testing

```bash
npm run compile
npm test
```

Unit tests cover the identifier scanner's regex fallback path and the
SQLite cache's per-repository isolation guarantee. (Decoration-rendering
behavior is inherently harder to unit test — it's covered by manual smoke
tests per VS Code release, see `KNOWN_LIMITATIONS.md` §1.)

## Project layout

```
src/
├── extension.ts                    # activation, command registration, wiring
├── types.ts                        # shared type definitions
├── config/ConfigManager.ts         # typed settings wrapper
├── cache/CacheManager.ts           # SQLite cache + multi-repo router
├── identifiers/
│   ├── IdentifierScanner.ts        # semantic-token-based + regex-fallback scanning
│   └── RepoIdentity.ts             # stable per-repo hash for cache isolation
├── translation/
│   ├── OllamaClient.ts             # local Ollama HTTP client, JSON-mode prompting
│   └── TranslationQueue.ts         # cache-first resolution + throttled model calls
└── decorations/
    └── DecorationController.ts     # pure-visual rendering, never edits the buffer
```

## Why the file is guaranteed unchanged

The extension never calls `TextEdit` / `WorkspaceEdit` on your source files.
All "translation" is implemented as editor decorations (a purely visual
layer VS Code renders on top of the real buffer). This is why `git status`
/ `git diff` will always show zero changes from this extension — there is
no code path in this project capable of writing to your files. See
`ARCHITECTURE.md` §1 and §6 for the mechanism.
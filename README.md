# AI Code Identifier Translator

Read source code that uses non-English identifiers (Chinese, Japanese,
Korean, Arabic, Russian, ...) displayed as English inside VS Code — **the
file on disk is never modified.** Translation runs entirely locally via
Ollama; nothing is sent to the cloud.

> This is Phase 1 (read-side, decoration-based display) of a two-phase plan.
> See `ARCHITECTURE.md` for the full design and `KNOWN_LIMITATIONS.md` for
> what's deliberately not implemented yet (in particular: no invisible
> write-back / editing support in this version — see §8 of the architecture
> doc for why and what's planned instead).

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

## Publishing to the VS Code Marketplace (free)

1. **Create a publisher.** Go to https://marketplace.visualstudio.com/manage
   and create a publisher ID (this becomes the `publisher` field in
   `package.json` — replace `REPLACE_WITH_YOUR_MARKETPLACE_PUBLISHER_ID`
   with it).
2. **Get an Azure DevOps Personal Access Token (PAT).** Publishing is done
   through Azure DevOps, not directly through the Marketplace site.
   - Go to https://dev.azure.com, sign in with the same Microsoft account.
   - User settings → Personal access tokens → New Token.
   - Scope: **Marketplace → Manage**. Copy the token somewhere safe — it's
     only shown once.
3. **Fill in the remaining placeholders** in `package.json` and `LICENSE`:
   `repository.url`, and the copyright name in `LICENSE`. Also replace the
   Gumroad placeholders in `src/licensing/LicenseManager.ts` (see below) if
   you're using the licensing feature.
4. **Package and publish:**
   ```bash
   npm install -g @vscode/vsce
   vsce login <your-publisher-id>   # paste the PAT when prompted
   vsce publish                     # bumps nothing by default; or:
   vsce publish patch               # bumps version and publishes in one step
   ```
   `vsce publish` runs `vscode:prepublish` (which compiles TypeScript)
   automatically before packaging.
5. An icon is optional but recommended — add a 128×128 PNG and reference it
   via `"icon": "images/icon.png"` in `package.json`. Without one, the
   Marketplace shows a generic default icon, which is fine for a first
   release.

The extension itself stays 100% free and fully functional either way —
nothing in this repo gates a feature behind a license. See below for what
the optional Pro-license nudge actually does.

## Optional: Pro license nudge (honor-system, not a paywall)

VS Code's Marketplace doesn't support charging for extensions directly, so
this project uses the common workaround: the extension is entirely free and
fully functional for everyone, and professional/commercial users are
occasionally invited (not required) to buy a Pro license to support
development. **No feature is ever gated** — this is a goodwill reminder,
not a technical restriction.

How it works (`src/licensing/LicenseManager.ts`):
- On first activation, a one-time, dismissible prompt asks whether usage is
  personal or professional. The answer is stored locally
  (`context.globalState`), never sent anywhere.
- If "professional" and no valid license key is stored, a reminder appears
  at most once every 2 weeks, offering to open the purchase page or enter
  an existing key.
- License keys are verified directly against Gumroad's public License
  Verification API (`https://api.gumroad.com/v2/licenses/verify`) — no
  backend server required. The key is stored in VS Code's encrypted
  `SecretStorage`, not in plaintext settings.

To enable this:
1. Create a product on https://gumroad.com (e.g. "AI Identifier Translator
   Pro License").
2. In `src/licensing/LicenseManager.ts`, replace:
   - `GUMROAD_PRODUCT_PERMALINK` with your product's permalink (the last
     segment of its Gumroad URL).
   - `PURCHASE_URL` with the full purchase page URL.
3. Recompile (`npm run compile`) and republish.

If you'd rather not include this at all, delete
`src/licensing/LicenseManager.ts`, remove its import and the
`enterLicenseKey` command registration plus the `runStartupCheck()` call in
`src/extension.ts`, and drop the corresponding command entry from
`package.json`.


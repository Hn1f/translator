"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaClient = exports.OllamaTranslationError = void 0;
exports.transliterationFallback = transliterationFallback;
const node_fetch_1 = __importDefault(require("node-fetch"));
const validation_1 = require("./validation");
const SYSTEM_PROMPT = `You translate source-code identifiers (variable, function, class, constant, and namespace names) from their original language into English, following software naming conventions:
- variable, parameter, function, method -> camelCase
- class, interface, struct, enum -> PascalCase
- constant, enum member -> UPPER_CASE
- namespace, module -> lowercase

Rules:
- Base the translation ONLY on the literal meaning of the identifier and the given role. Do not invent meaning from context you were not given.
- Preserve the identifier's role convention exactly.
- CRITICAL: your output must be ENGLISH ONLY. Every translated name must use only the Latin letters a-z, A-Z, and digits (joined per the casing convention above). Never output Arabic, Japanese, Chinese, Korean, Cyrillic, or any other non-Latin characters — not even mixed in with the English. If you are unsure of an exact translation, give your best short English guess rather than leaving any part of the original script untranslated.
- You will receive a numbered list of identifiers. Respond with ONLY a minified JSON array of translated names, in the exact same order and with the exact same number of elements as the input list. Do not include the original identifier text anywhere in your response, no explanations, no markdown fences — array of strings only.`;
class OllamaTranslationError extends Error {
}
exports.OllamaTranslationError = OllamaTranslationError;
class OllamaClient {
    constructor(endpoint, model, temperature) {
        this.endpoint = endpoint;
        this.model = model;
        this.temperature = temperature;
    }
    updateSettings(endpoint, model, temperature) {
        this.endpoint = endpoint;
        this.model = model;
        this.temperature = temperature;
    }
    /**
     * Translates an entire file's worth of identifiers in one call, giving
     * the model class-level context per requirement §4, and returns a map of
     * original -> translated.
     *
     * IMPORTANT: the exchange is positional (an ordered JSON array), not a
     * JSON object keyed by the original identifier text. An earlier version
     * asked the model to echo the original CJK/Arabic/Cyrillic text back as a
     * JSON key — small models like qwen2.5:1.5b don't reliably reproduce
     * non-Latin text byte-for-byte as a key (Unicode normalization drift,
     * minor rephrasing, etc.), so `translations.get(token.original)` would
     * silently miss even when the model's response was substantively correct,
     * and every identifier would fall through to the id_xxxxx placeholder
     * despite the request having "succeeded". Positional array responses sidestep
     * this entirely: we zip the response array against the request array by
     * index, so there's no dependency on the model preserving exact text.
     */
    async translateBatch(batch) {
        const prompt = this.buildPrompt(batch);
        const raw = await this.callOllama(prompt);
        const parsed = this.tryParse(raw, batch);
        if (parsed)
            return parsed;
        // one retry with a stricter reminder
        const retryRaw = await this.callOllama(prompt +
            `\n\nReminder: respond with ONLY a JSON array of exactly ${batch.identifiers.length} strings, nothing else.`);
        const retryParsed = this.tryParse(retryRaw, batch);
        if (retryParsed)
            return retryParsed;
        throw new OllamaTranslationError(`Model returned an unusable response twice for ${batch.filePath} (expected a ${batch.identifiers.length}-element JSON array)`);
    }
    buildPrompt(batch) {
        const lines = batch.identifiers
            .map((id, i) => `${i + 1}. (${id.role}) ${id.text}`)
            .join('\n');
        return `Language context: ${batch.languageId} source file.\nTranslate these ${batch.identifiers.length} identifiers, in order:\n${lines}\n\nRespond with ONLY a JSON array of exactly ${batch.identifiers.length} translated names, same order as above.`;
    }
    async callOllama(prompt) {
        const res = await (0, node_fetch_1.default)(`${this.endpoint}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                system: SYSTEM_PROMPT,
                prompt,
                stream: false,
                // Note: no `format: 'json'` here — Ollama's JSON mode forces object
                // output on some models, which fights against the array format we
                // actually want. We parse leniently instead (see tryParse).
                options: { temperature: this.temperature },
            }),
        });
        if (!res.ok) {
            throw new OllamaTranslationError(`Ollama request failed: ${res.status} ${res.statusText}. Is Ollama running locally on ${this.endpoint}?`);
        }
        const data = (await res.json());
        return data.response;
    }
    /**
     * Parses the model's response as a JSON array and zips it positionally
     * against the original request. Falls back to scanning for the first
     * `[...]` substring in case the model wrapped the array in prose despite
     * instructions not to. Rejects (returns null) if the array length doesn't
     * match — a length mismatch means we can no longer trust the ordering,
     * and a silently-misaligned translation is worse than an explicit retry.
     *
     * Per-item validation: some scripts (Arabic and Japanese moreso than
     * Chinese, in practice with small local models) tend to get "translated"
     * right back into the same script instead of English — the model
     * paraphrases rather than translates. Rather than accept and cache a
     * wrong non-English "success", each item is checked against an
     * English-only pattern; anything that still contains non-Latin
     * characters is dropped from the map so that specific identifier falls
     * through to the id_xxxxx placeholder (and gets retried on the next scan,
     * per the confidence>0 cache-hit rule) instead of being cached as if it
     * were a good translation.
     */
    tryParse(raw, batch) {
        const candidate = this.extractJsonArray(raw);
        if (!candidate)
            return null;
        try {
            const arr = JSON.parse(candidate);
            if (!Array.isArray(arr))
                return null;
            if (arr.length !== batch.identifiers.length)
                return null;
            if (!arr.every((v) => typeof v === 'string' && v.trim().length > 0))
                return null;
            const map = new Map();
            batch.identifiers.forEach((id, i) => {
                const translated = arr[i].trim();
                if ((0, validation_1.isValidTranslation)(translated)) {
                    map.set(id.text, translated);
                }
                // else: left out of the map on purpose — see per-item validation note above.
            });
            return map.size > 0 ? map : null;
        }
        catch {
            return null;
        }
    }
    extractJsonArray(raw) {
        const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']'))
            return trimmed;
        const start = trimmed.indexOf('[');
        const end = trimmed.lastIndexOf(']');
        if (start === -1 || end === -1 || end <= start)
            return null;
        return trimmed.slice(start, end + 1);
    }
}
exports.OllamaClient = OllamaClient;
/**
 * Deterministic last-resort fallback when the model is unavailable or keeps
 * returning malformed output. Not a translation — just makes the UI show
 * *something* readable rather than blocking, tagged confidence 0.0 so the
 * decoration renders in the "low confidence" color and the user knows to
 * distrust it.
 */
function transliterationFallback(original, role) {
    // Intentionally simple: strips to a placeholder rather than shipping a
    // heavyweight pinyin/romaji dependency in this deliverable. Swap in
    // `pinyin` / `wanakana` / `korean-romanizer` packages per script here.
    const slug = `id_${Buffer.from(original).toString('hex').slice(0, 6)}`;
    if (role === 'class')
        return slug[0].toUpperCase() + slug.slice(1);
    if (role === 'constant')
        return slug.toUpperCase();
    return slug;
}
//# sourceMappingURL=OllamaClient.js.map
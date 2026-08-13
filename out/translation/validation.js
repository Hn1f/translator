"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENGLISH_ONLY_RE = void 0;
exports.isValidTranslation = isValidTranslation;
/**
 * A valid translated identifier is Latin letters/digits/underscore only.
 * Shared between OllamaClient (validating fresh model output) and
 * CacheManager (revalidating stored rows on read) so that a cache entry
 * written before this check existed — or written by a future code path
 * that forgets to validate — can never silently resurface a non-English
 * "translation" (e.g. a small model paraphrasing Arabic back into Arabic
 * instead of translating it).
 */
exports.ENGLISH_ONLY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function isValidTranslation(text) {
    return exports.ENGLISH_ONLY_RE.test(text);
}
//# sourceMappingURL=validation.js.map
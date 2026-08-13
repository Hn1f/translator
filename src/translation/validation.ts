/**
 * A valid translated identifier is Latin letters/digits/underscore only.
 * Shared between OllamaClient (validating fresh model output) and
 * CacheManager (revalidating stored rows on read) so that a cache entry
 * written before this check existed — or written by a future code path
 * that forgets to validate — can never silently resurface a non-English
 * "translation" (e.g. a small model paraphrasing Arabic back into Arabic
 * instead of translating it).
 */
export const ENGLISH_ONLY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidTranslation(text: string): boolean {
  return ENGLISH_ONLY_RE.test(text);
}

export type IdentifierRole =
  | 'variable'
  | 'function'
  | 'class'
  | 'constant'
  | 'namespace'
  | 'parameter'
  | 'unknown';

export type SourceScript = 'zh' | 'ja' | 'ko' | 'ar' | 'ru' | 'en' | 'unknown';

/** A candidate identifier found in a document, not yet necessarily translated. */
export interface IdentifierToken {
  /** The exact original text, as it appears on disk. */
  original: string;
  /** 0-based line number. */
  line: number;
  /** 0-based start column. */
  startChar: number;
  /** 0-based end column (exclusive). */
  endChar: number;
  role: IdentifierRole;
  script: SourceScript;
}

/** A resolved translation, either from cache or freshly produced by the model. */
export interface TranslationResult {
  original: string;
  translated: string;
  role: IdentifierRole;
  script: SourceScript;
  confidence: number; // 0.0 (fallback) .. 1.0 (high-confidence model output)
  model: string;
}

export interface CacheRecord extends TranslationResult {
  repoHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface TranslationRequestBatch {
  repoHash: string;
  filePath: string;
  languageId: string;
  identifiers: { text: string; role: IdentifierRole }[];
}

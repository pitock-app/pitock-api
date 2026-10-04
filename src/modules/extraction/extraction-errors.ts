/** Codici salvati in `receipts_raw.error_code` quando l'estrazione fallisce. */
export const EXTRACTION_ERROR_CODES = [
  "NOT_A_RECEIPT",
  "INVALID_OUTPUT",
  "UNSUPPORTED_FILE_TYPE",
  "USER_KEY_MISSING",
  "USER_KEY_INVALID",
  "USER_KEY_QUOTA",
  "PLATFORM_QUOTA_EXCEEDED",
  "AI_NOT_CONFIGURED",
  "LLM_UNAVAILABLE",
  "FILE_UNAVAILABLE",
  "INTERNAL",
] as const;

export type ExtractionErrorCode = (typeof EXTRACTION_ERROR_CODES)[number];

/** Fallimento previsto dell'estrazione: lo scontrino passa a `failed` con questo codice. */
export class ExtractionFailure extends Error {
  override readonly name = "ExtractionFailure";

  constructor(
    readonly code: ExtractionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

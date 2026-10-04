export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  INVALID_STATE: 409,
  UPLOAD_MISSING: 409,
  UPLOAD_MISMATCH: 422,
  UNSUPPORTED_FILE_TYPE: 415,
  FILE_TOO_LARGE: 413,
  USER_KEY_MISSING: 409,
  USER_KEY_INVALID: 422,
  USER_KEY_QUOTA: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  PROVIDER_UNAVAILABLE: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Errore di dominio: l'error handler lo converte in `{ error: { code, message, requestId } }`. */
export class AppError extends Error {
  override readonly name = "AppError";
  readonly status: (typeof ERROR_CODES)[ErrorCode];

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Campi aggiuntivi pubblici nel corpo dell'errore (es. `duplicateOf`). */
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.status = ERROR_CODES[code];
  }
}

export const notFound = (what = "Risorsa") => new AppError("NOT_FOUND", `${what} non trovata`);

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError, type ErrorCode } from "../shared/errors.js";
import type { AppEnv } from "../types.js";

export const errorBody = (
  c: Context<AppEnv>,
  code: ErrorCode,
  message: string,
  details?: Record<string, string>,
) => ({ error: { code, message, requestId: c.get("requestId"), ...details } });

/** Unico punto in cui gli errori diventano risposte `{ error: { code, message, requestId } }`. */
export function onError(err: Error, c: Context<AppEnv>) {
  if (err instanceof AppError) {
    if (err.status >= 500) c.get("logger").error({ err, code: err.code }, "app error");
    return c.json(errorBody(c, err.code, err.message, err.details), err.status);
  }
  if (err instanceof HTTPException && err.status < 500) {
    const code: ErrorCode = err.status === 401 ? "UNAUTHORIZED" : "VALIDATION_ERROR";
    return c.json(errorBody(c, code, "Richiesta non valida"), err.status);
  }
  c.get("logger").error({ err }, "unhandled error");
  return c.json(errorBody(c, "INTERNAL", "Errore interno"), 500);
}

export function onNotFound(c: Context<AppEnv>) {
  return c.json(errorBody(c, "NOT_FOUND", "Risorsa non trovata"), 404);
}

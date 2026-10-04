import { z } from "@hono/zod-openapi";
import { parseIsoInTimeZone } from "./dates.js";

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "NOT_FOUND" }),
      message: z.string(),
      requestId: z.string(),
    }),
  })
  .openapi("Error");

export const DuplicateErrorResponse = z
  .object({
    error: z.object({
      code: z.literal("DUPLICATE"),
      message: z.string(),
      requestId: z.string(),
      duplicateOf: z.uuid(),
    }),
  })
  .openapi("DuplicateError");

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export const jsonResponse = json;

/** Risposte di errore comuni a tutte le rotte autenticate. */
export const commonErrors = {
  400: json(ErrorResponse, "Richiesta non valida"),
  401: json(ErrorResponse, "Token mancante o non valido"),
  429: json(ErrorResponse, "Troppe richieste"),
  500: json(ErrorResponse, "Errore interno"),
  503: json(ErrorResponse, "Servizio temporaneamente non disponibile"),
} as const;

export const notFoundError = { 404: json(ErrorResponse, "Risorsa non trovata") } as const;

export const security = [{ bearerAuth: [] }];

export const IdParam = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});

/** Data ISO 8601 (data sola o data/ora); senza fuso vale Europe/Rome. */
export const IsoDateInput = z
  .string()
  .max(40)
  .refine((v) => parseIsoInTimeZone(v) !== null, { message: "data ISO 8601 non valida" })
  .openapi({ example: "2026-10-04T12:30:00+02:00" });

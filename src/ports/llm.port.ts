import type { z } from "zod";
import type { Provider } from "../config/env.js";
import type { MimeType } from "../shared/files.js";

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface LlmRequest {
  provider: Provider;
  model: string;
  /** In chiaro solo in memoria, per la durata della chiamata. */
  apiKey: string;
  instructions: string;
  prompt: string;
  file: { bytes: Uint8Array; mimeType: MimeType };
  schema: z.ZodType;
}

export interface LlmResult {
  /** Output strutturato del modello: va sempre rivalidato con Zod da chi lo usa. */
  output: unknown;
  usage: LlmUsage;
}

/**
 * - `auth`: chiave non valida o senza permessi
 * - `quota`: credito o quota del provider esauriti
 * - `unsupported_file`: il provider o il modello non accetta il file (es. PDF)
 * - `invalid_output`: risposta non conforme allo schema
 * - `unavailable`: qualunque altro errore del provider o di rete
 */
export type LlmErrorKind = "auth" | "quota" | "unsupported_file" | "invalid_output" | "unavailable";

/** Errore del provider già classificato. Il messaggio non contiene mai la chiave né la risposta. */
export class LlmError extends Error {
  override readonly name = "LlmError";

  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly usage: LlmUsage | null = null,
  ) {
    super(message);
  }
}

/** Chiamata minima per provare chiave e modello (`POST /v1/settings/ai/test`). */
export interface LlmPingRequest {
  provider: Provider;
  model: string;
  /** In chiaro solo in memoria, per la durata della chiamata. */
  apiKey: string;
}

export interface LlmPort {
  generateStructured(req: LlmRequest): Promise<LlmResult>;
  /** Lancia `LlmError` se chiave o modello non funzionano. */
  ping(req: LlmPingRequest): Promise<{ usage: LlmUsage }>;
}

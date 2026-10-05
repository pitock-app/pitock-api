import {
  APICallError,
  generateText,
  JSONParseError,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  TypeValidationError,
  UnsupportedFunctionalityError,
  type LanguageModelUsage,
} from "ai";
import { createProviderModel, type ModelFactory } from "../../modules/ai/providers.js";
import { LlmError, type LlmPort, type LlmUsage } from "../../ports/llm.port.js";

const toUsage = (u: LanguageModelUsage | undefined): LlmUsage => ({
  inputTokens: u?.inputTokens ?? null,
  outputTokens: u?.outputTokens ?? null,
  totalTokens:
    u?.totalTokens ??
    (u?.inputTokens !== undefined && u.outputTokens !== undefined
      ? u.inputTokens + u.outputTokens
      : null),
});

/** Prompt minimo di `ping`: pochi token, nessun file. */
export const PING_PROMPT = "Rispondi solo con: ok";

const FILE_HINT = /pdf|document|file|media[ _-]?type|mime|image|unsupported/i;
/** Anthropic risponde 400 (non 402) quando il credito è esaurito. */
const CREDIT_HINT = /credit balance/i;

/** Classifica gli errori del provider senza mai riportare chiave, corpo della richiesta o risposta. */
export function classifyLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (NoObjectGeneratedError.isInstance(err)) {
    return new LlmError("invalid_output", "Output del modello non valido", toUsage(err.usage));
  }
  if (
    NoOutputGeneratedError.isInstance(err) ||
    TypeValidationError.isInstance(err) ||
    JSONParseError.isInstance(err)
  ) {
    return new LlmError("invalid_output", "Output del modello non valido");
  }
  if (UnsupportedFunctionalityError.isInstance(err)) {
    return new LlmError("unsupported_file", "Tipo di file non supportato dal modello");
  }
  if (LoadAPIKeyError.isInstance(err)) return new LlmError("auth", "Chiave API assente");
  if (APICallError.isInstance(err)) {
    const status = err.statusCode ?? 0;
    if (status === 401 || status === 403) return new LlmError("auth", "Chiave API non valida");
    if (status === 402 || status === 429)
      return new LlmError("quota", "Quota del provider esaurita");
    if (status === 400 && CREDIT_HINT.test(err.responseBody ?? err.message)) {
      return new LlmError("quota", "Quota del provider esaurita");
    }
    if ([400, 413, 415, 422].includes(status) && FILE_HINT.test(err.responseBody ?? err.message)) {
      return new LlmError("unsupported_file", "Tipo di file non supportato dal modello");
    }
    return new LlmError("unavailable", `Errore del provider (HTTP ${status})`);
  }
  return new LlmError("unavailable", "Errore del provider");
}

/** Adapter Vercel AI SDK: `generateText` con output strutturato validato da Zod. */
export function createAiSdkLlm(modelFactory: ModelFactory = createProviderModel): LlmPort {
  return {
    async generateStructured(req) {
      try {
        const result = await generateText({
          model: modelFactory(req.provider, req.model, req.apiKey),
          output: Output.object({ schema: req.schema }),
          instructions: req.instructions,
          maxRetries: 1,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: req.prompt },
                ...req.files.map((file) => ({
                  type: "file" as const,
                  mediaType: file.mimeType,
                  data: file.bytes,
                  ...(file.mimeType === "application/pdf" ? { filename: "scontrino.pdf" } : {}),
                })),
              ],
            },
          ],
        });
        return { output: result.output, usage: toUsage(result.usage) };
      } catch (err) {
        throw classifyLlmError(err);
      }
    },

    async ping(req) {
      try {
        const result = await generateText({
          model: modelFactory(req.provider, req.model, req.apiKey),
          prompt: PING_PROMPT,
          maxOutputTokens: 16,
          maxRetries: 0,
        });
        return { usage: toUsage(result.usage) };
      } catch (err) {
        throw classifyLlmError(err);
      }
    },
  };
}

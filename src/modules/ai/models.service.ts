import type { Provider } from "../../config/env.js";
import { apiKeyContext, type KeyCipher } from "../../infra/crypto/key-cipher.js";
import type { Clock } from "../../ports/clock.port.js";
import { LlmError, type LlmPort, type LlmUsage } from "../../ports/llm.port.js";
import type { ModelCatalogPort } from "../../ports/model-catalog.port.js";
import { AppError } from "../../shared/errors.js";
import { providerError } from "../settings/settings.service.js";
import type { SettingsRepo } from "../settings/settings.repo.js";
import { costUsd } from "../usage/pricing.js";
import type { UsageRepo } from "../usage/usage.repo.js";

export interface ModelsDeps {
  settings: SettingsRepo;
  usage: UsageRepo;
  catalog: ModelCatalogPort;
  llm: LlmPort;
  cipher: KeyCipher | null;
  clock: Clock;
}

type TestErrorCode = "USER_KEY_INVALID" | "USER_KEY_QUOTA" | "LLM_UNAVAILABLE";

const testError = (e: LlmError): { code: TestErrorCode; message: string } => {
  switch (e.kind) {
    case "auth":
      return { code: "USER_KEY_INVALID", message: "Chiave API rifiutata dal provider" };
    case "quota":
      return { code: "USER_KEY_QUOTA", message: "Quota o credito del provider esauriti" };
    default:
      return { code: "LLM_UNAVAILABLE", message: "Modello non disponibile con questa chiave" };
  }
};

/** Catalogo dei modelli dei provider e prova di chiave + modello (`/v1/settings/ai/models|test`). */
export function createModelsService(d: ModelsDeps) {
  /** Chiave salvata dell'utente, decifrata solo in memoria; `null` se non c'è. */
  const savedKey = async (userId: string, provider: Provider): Promise<string | null> => {
    const row = await d.settings.getApiKey(userId, provider);
    if (!row) return null;
    if (!d.cipher) throw new AppError("SERVICE_UNAVAILABLE", "Cifratura non configurata");
    try {
      return d.cipher.decrypt(row, apiKeyContext(userId, provider));
    } catch {
      throw new AppError("USER_KEY_INVALID", "Chiave salvata non decifrabile: salvala di nuovo");
    }
  };

  return {
    /** Elenco in tempo reale con la chiave dell'utente; OpenRouter ha un elenco pubblico. */
    async list(userId: string, provider: Provider) {
      const apiKey = await savedKey(userId, provider);
      if (!apiKey && provider !== "openrouter") {
        throw new AppError("USER_KEY_MISSING", `Salva prima una chiave per ${provider}`);
      }
      try {
        return { models: await d.catalog.listModels(provider, apiKey) };
      } catch (err) {
        throw providerError(err);
      }
    },

    /** Chiamata minima con la chiave data o con quella salvata; registrata in `llm_usage` (`key_test`). */
    async test(userId: string, input: { provider: Provider; model: string; apiKey?: string }) {
      const apiKey = input.apiKey ?? (await savedKey(userId, input.provider));
      if (!apiKey) {
        throw new AppError("USER_KEY_MISSING", `Nessuna chiave salvata per ${input.provider}`);
      }
      const started = d.clock.now();
      let usage: LlmUsage | null;
      let error: { code: TestErrorCode; message: string } | null = null;
      try {
        ({ usage } = await d.llm.ping({ provider: input.provider, model: input.model, apiKey }));
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
        usage = err.usage;
        error = testError(err);
      }
      const u = usage ?? { inputTokens: null, outputTokens: null, totalTokens: null };
      const price = await d.usage.findPrice(input.provider, input.model);
      await d.usage.insertMany(userId, [
        {
          operation: "key_test",
          provider: input.provider,
          model: input.model,
          keySource: "user",
          ...u,
          costUsd: costUsd(price, u.inputTokens, u.outputTokens),
          latencyMs: Math.max(0, d.clock.now().getTime() - started.getTime()),
          success: error === null,
          errorCode: error?.code ?? null,
          createdAt: started,
        },
      ]);
      return error ? { ok: false, error } : { ok: true };
    },
  };
}

export type ModelsService = ReturnType<typeof createModelsService>;

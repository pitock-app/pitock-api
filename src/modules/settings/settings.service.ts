import { PROVIDERS, type Env, type Provider } from "../../config/env.js";
import { apiKeyContext, last4, type KeyCipher } from "../../infra/crypto/key-cipher.js";
import type { Clock } from "../../ports/clock.port.js";
import { LlmError } from "../../ports/llm.port.js";
import type { ModelCatalogPort } from "../../ports/model-catalog.port.js";
import { AppError, notFound } from "../../shared/errors.js";
import { platformQuota } from "../usage/quota.js";
import type { UsageRepo } from "../usage/usage.repo.js";
import type { ApiKeySummary, SettingsRepo } from "./settings.repo.js";
import type { AiSettingsInput } from "./settings.schemas.js";

export interface SettingsDeps {
  settings: SettingsRepo;
  usage: UsageRepo;
  catalog: ModelCatalogPort;
  cipher: KeyCipher | null;
  clock: Clock;
  env: Pick<Env, "PLATFORM_MONTHLY_RECEIPT_LIMIT">;
}

const asProvider = (v: string | null | undefined): Provider | null =>
  PROVIDERS.find((p) => p === v) ?? null;

const toKeyInfo = (provider: Provider, k: ApiKeySummary) => ({
  provider,
  last4: k.last4,
  verifiedAt: k.verifiedAt ? k.verifiedAt.toISOString() : null,
});

/** Errore del provider durante la verifica di una chiave → errore HTTP, senza dettagli del provider. */
export function providerError(err: unknown): AppError {
  if (!(err instanceof LlmError)) throw err;
  switch (err.kind) {
    case "auth":
      return new AppError("USER_KEY_INVALID", "Chiave API rifiutata dal provider");
    case "quota":
      return new AppError("USER_KEY_QUOTA", "Quota o credito del provider esauriti");
    default:
      return new AppError("PROVIDER_UNAVAILABLE", "Provider non raggiungibile, riprova più tardi");
  }
}

/** Impostazioni AI e chiavi BYOK (`/v1/settings/ai*`). La chiave in chiaro non esce mai. */
export function createSettingsService(d: SettingsDeps) {
  const requireCipher = () => {
    if (!d.cipher) throw new AppError("SERVICE_UNAVAILABLE", "Cifratura non configurata");
    return d.cipher;
  };

  const get = async (userId: string) => {
    const s = await d.settings.getAiSettings(userId);
    const keys = await d.settings.listApiKeys(userId);
    return {
      mode: s?.mode ?? ("platform" as const),
      provider: asProvider(s?.provider),
      model: s?.model ?? null,
      fallbackToPlatform: s?.fallbackToPlatform ?? false,
      keys: keys.flatMap((k) => {
        const provider = asProvider(k.provider);
        return provider ? [toKeyInfo(provider, k)] : [];
      }),
      platformQuota: await platformQuota(
        d.usage,
        d.clock,
        userId,
        d.env.PLATFORM_MONTHLY_RECEIPT_LIMIT,
      ),
    };
  };

  return {
    get,

    /** I campi omessi restano invariati; con `byok` servono provider, modello e chiave salvata. */
    async update(userId: string, input: AiSettingsInput) {
      const s = await d.settings.getAiSettings(userId);
      const next = {
        mode: input.mode,
        provider: input.provider === undefined ? asProvider(s?.provider) : input.provider,
        model: input.model === undefined ? (s?.model ?? null) : input.model,
        fallbackToPlatform: input.fallbackToPlatform ?? s?.fallbackToPlatform ?? false,
      };
      if (next.mode === "byok") {
        if (!next.provider || !next.model) {
          throw new AppError("VALIDATION_ERROR", "Con mode=byok servono provider e model");
        }
        if (!(await d.settings.getApiKey(userId, next.provider))) {
          throw new AppError("USER_KEY_MISSING", `Nessuna chiave salvata per ${next.provider}`);
        }
      }
      await d.settings.upsertAiSettings(userId, next, d.clock.now());
      return get(userId);
    },

    /** Verifica la chiave sul provider, poi la cifra (AAD `userId:provider`) e la salva. */
    async putKey(userId: string, provider: Provider, apiKey: string) {
      const cipher = requireCipher();
      try {
        await d.catalog.verifyKey(provider, apiKey);
      } catch (err) {
        throw providerError(err);
      }
      const secret = cipher.encrypt(apiKey, apiKeyContext(userId, provider));
      const saved = await d.settings.upsertApiKey(
        userId,
        provider,
        secret,
        last4(apiKey),
        d.clock.now(),
      );
      return toKeyInfo(provider, saved);
    },

    async deleteKey(userId: string, provider: Provider) {
      if (!(await d.settings.deleteApiKey(userId, provider, d.clock.now()))) {
        throw notFound("Chiave");
      }
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;

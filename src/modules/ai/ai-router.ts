import { PROVIDERS, type Env, type Provider } from "../../config/env.js";
import { apiKeyContext, type KeyCipher } from "../../infra/crypto/key-cipher.js";
import type { Clock } from "../../ports/clock.port.js";
import { startOfMonth } from "../../shared/dates.js";
import { ExtractionFailure } from "../extraction/extraction-errors.js";
import type { SettingsRepo } from "../settings/settings.repo.js";
import type { UsageRepo } from "../usage/usage.repo.js";

export interface AiConfig {
  provider: Provider;
  model: string;
  /** In chiaro solo in memoria: mai nei log, nelle risposte o negli eventi. */
  apiKey: string;
  keySource: "platform" | "user";
}

export interface AiPlan {
  primary: AiConfig;
  /** Con BYOK e `fallback_to_platform`: se la chiave utente fallisce si riprova sulla piattaforma. */
  fallbackToPlatform: boolean;
}

export interface AiOverride {
  provider?: Provider | undefined;
  model?: string | undefined;
}

export interface AiRouterDeps {
  settings: SettingsRepo;
  usage: UsageRepo;
  clock: Clock;
  cipher: KeyCipher | null;
  env: Pick<
    Env,
    "DEFAULT_PROVIDER" | "DEFAULT_MODEL" | "PLATFORM_API_KEY" | "PLATFORM_MONTHLY_RECEIPT_LIMIT"
  >;
}

const isProvider = (v: string | null | undefined): v is Provider => PROVIDERS.some((p) => p === v);

/** Sceglie provider, modello e chiave di ogni estrazione (sezione 7). */
export function createAiRouter(d: AiRouterDeps) {
  /** Chiave della piattaforma, sempre con `DEFAULT_PROVIDER`/`DEFAULT_MODEL`, dentro la quota mensile. */
  const platform = async (userId: string): Promise<AiConfig> => {
    const { DEFAULT_PROVIDER, DEFAULT_MODEL, PLATFORM_API_KEY } = d.env;
    if (!DEFAULT_MODEL || !PLATFORM_API_KEY) {
      throw new ExtractionFailure("AI_NOT_CONFIGURED", "Modello della piattaforma non configurato");
    }
    const used = await d.usage.countPlatformCallsSince(userId, startOfMonth(d.clock.now()));
    if (used >= d.env.PLATFORM_MONTHLY_RECEIPT_LIMIT) {
      throw new ExtractionFailure(
        "PLATFORM_QUOTA_EXCEEDED",
        "Quota mensile della piattaforma esaurita",
      );
    }
    return {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      apiKey: PLATFORM_API_KEY,
      keySource: "platform",
    };
  };

  const userKey = async (userId: string, provider: Provider): Promise<string | null> => {
    const row = await d.settings.getApiKey(userId, provider);
    if (!row) return null;
    if (!d.cipher) throw new ExtractionFailure("AI_NOT_CONFIGURED", "Cifratura non configurata");
    try {
      return d.cipher.decrypt(row, apiKeyContext(userId, provider));
    } catch {
      throw new ExtractionFailure("USER_KEY_INVALID", "Chiave salvata non decifrabile");
    }
  };

  return {
    platform,

    /**
     * Senza impostazioni o con `mode=platform` si usa la piattaforma; con `mode=byok`, o se
     * `override.provider` chiede un provider diverso da quello della piattaforma, la chiave
     * dell'utente per quel provider. L'override del modello vale solo con la chiave dell'utente.
     */
    async resolveAiConfig(userId: string, override: AiOverride = {}): Promise<AiPlan> {
      const s = await d.settings.getAiSettings(userId);
      const byok = s?.mode === "byok";
      const fallbackToPlatform = s?.fallbackToPlatform ?? false;
      const saved = isProvider(s?.provider) ? s.provider : null;
      const provider = override.provider ?? (byok && saved ? saved : d.env.DEFAULT_PROVIDER);

      if (!byok && provider === d.env.DEFAULT_PROVIDER) {
        return { primary: await platform(userId), fallbackToPlatform: false };
      }

      const model = override.model ?? (saved === provider ? (s?.model ?? null) : null);
      const apiKey = await userKey(userId, provider);
      if (!apiKey || !model) {
        if (fallbackToPlatform)
          return { primary: await platform(userId), fallbackToPlatform: false };
        throw apiKey
          ? new ExtractionFailure("AI_NOT_CONFIGURED", "Nessun modello scelto per il provider")
          : new ExtractionFailure("USER_KEY_MISSING", `Nessuna chiave salvata per ${provider}`);
      }
      return { primary: { provider, model, apiKey, keySource: "user" }, fallbackToPlatform };
    },
  };
}

export type AiRouter = ReturnType<typeof createAiRouter>;

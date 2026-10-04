import { z } from "@hono/zod-openapi";
import { PROVIDERS } from "../../config/env.js";
import { MIN_API_KEY_LENGTH } from "../../infra/crypto/key-cipher.js";

export const ProviderSchema = z.enum(PROVIDERS).openapi("Provider");
export const AiModeSchema = z.enum(["platform", "byok"]).openapi("AiMode");

/** ID del modello come lo espone il provider (es. `vendor/model:variant`). */
export const ModelId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.:/@+-]+$/)
  .openapi({ description: "ID del modello restituito da GET /v1/settings/ai/models" });

/** Chiave API in chiaro: solo in ingresso, mai in uscita. */
const ApiKeyInput = z
  .string()
  .trim()
  .min(MIN_API_KEY_LENGTH)
  .max(512)
  .regex(/^\S+$/)
  .openapi({ description: "Chiave API del provider: non viene mai restituita" });

export const ProviderParam = z.object({
  provider: ProviderSchema.openapi({ param: { name: "provider", in: "path" } }),
});

const PlatformQuota = z
  .object({ used: z.number().int(), limit: z.number().int() })
  .openapi("PlatformQuota");

export const ApiKeyInfo = z
  .object({
    provider: ProviderSchema,
    last4: z.string().openapi({ description: "Ultimi 4 caratteri della chiave" }),
    verifiedAt: z.iso.datetime().nullable(),
  })
  .openapi("ApiKeyInfo");

export const AiSettings = z
  .object({
    mode: AiModeSchema,
    provider: z.union([ProviderSchema, z.null()]),
    model: z.string().nullable(),
    fallbackToPlatform: z.boolean(),
    keys: z.array(ApiKeyInfo),
    platformQuota: PlatformQuota,
  })
  .openapi("AiSettings");

export const AiSettingsInput = z
  .object({
    mode: AiModeSchema,
    provider: z.union([ProviderSchema, z.null()]).optional(),
    model: z.union([ModelId, z.null()]).optional(),
    fallbackToPlatform: z.boolean().optional(),
  })
  .openapi("AiSettingsInput", {
    description:
      "I campi omessi restano invariati. Con mode=byok servono provider, model e una chiave salvata per il provider.",
  });
export type AiSettingsInput = z.infer<typeof AiSettingsInput>;

export const ApiKeyBody = z.object({ apiKey: ApiKeyInput }).openapi("ApiKeyInput");

export const AiTestBody = z
  .object({ provider: ProviderSchema, model: ModelId, apiKey: ApiKeyInput.optional() })
  .openapi("AiTestInput", {
    description: "Senza apiKey si usa la chiave salvata dell'utente per il provider.",
  });
export type AiTestBody = z.infer<typeof AiTestBody>;

export const AiTestResult = z
  .object({
    ok: z.boolean(),
    error: z
      .object({
        code: z.enum(["USER_KEY_INVALID", "USER_KEY_QUOTA", "LLM_UNAVAILABLE"]),
        message: z.string(),
      })
      .optional(),
  })
  .openapi("AiTestResult");

export const ModelsQuery = z.object({ provider: ProviderSchema });

export const ModelInfo = z
  .object({
    id: z.string(),
    label: z.string(),
    supportsImages: z
      .boolean()
      .nullable()
      .openapi({ description: "null se il provider non dichiara la capacità" }),
    supportsPdf: z
      .boolean()
      .nullable()
      .openapi({ description: "null se il provider non dichiara la capacità" }),
  })
  .openapi("ModelInfo");

export const ModelsResponse = z.object({ models: z.array(ModelInfo) }).openapi("ModelList");

import { z } from "zod";
import type { Provider } from "../../config/env.js";
import { LlmError } from "../../ports/llm.port.js";
import type { CatalogModel, ModelCatalogPort } from "../../ports/model-catalog.port.js";

export const CATALOG_ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/models",
  openai: "https://api.openai.com/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models",
  openrouterKey: "https://openrouter.ai/api/v1/key",
} as const;

const TIMEOUT_MS = 10_000;
/** Pagine al massimo per Anthropic (1000 modelli ciascuna). */
const MAX_PAGES = 5;

const Supported = z.object({ supported: z.boolean() }).nullish();

const AnthropicPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      display_name: z.string().nullish(),
      capabilities: z.object({ image_input: Supported, pdf_input: Supported }).nullish(),
    }),
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().nullish(),
});

const OpenAiList = z.object({ data: z.array(z.object({ id: z.string() })) });

const OpenRouterList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullish(),
      architecture: z.object({ input_modalities: z.array(z.string()).nullish() }).nullish(),
    }),
  ),
});

const headers = (provider: Provider, apiKey: string | null): Record<string, string> => {
  if (!apiKey) return {};
  return provider === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
};

/** Classifica gli errori HTTP del provider senza riportare corpo della risposta né chiave. */
const httpError = (status: number) => {
  if (status === 401 || status === 403) return new LlmError("auth", "Chiave API non valida");
  if (status === 402 || status === 429) return new LlmError("quota", "Quota del provider esaurita");
  return new LlmError("unavailable", `Errore del provider (HTTP ${status})`);
};

export function createModelCatalog(fetchFn: typeof fetch = fetch): ModelCatalogPort {
  const get = async <T>(
    url: string,
    provider: Provider,
    apiKey: string | null,
    schema: z.ZodType<T>,
  ) => {
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: headers(provider, apiKey),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new LlmError("unavailable", "Provider non raggiungibile");
    }
    if (!res.ok) throw httpError(res.status);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new LlmError("unavailable", "Risposta del provider non valida");
    return parsed.data;
  };

  const anthropic = async (apiKey: string | null) => {
    const models: CatalogModel[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(CATALOG_ENDPOINTS.anthropic);
      url.searchParams.set("limit", "1000");
      if (after) url.searchParams.set("after_id", after);
      const body = await get(url.toString(), "anthropic", apiKey, AnthropicPage);
      for (const m of body.data) {
        models.push({
          id: m.id,
          label: m.display_name ?? m.id,
          supportsImages: m.capabilities?.image_input?.supported ?? null,
          supportsPdf: m.capabilities?.pdf_input?.supported ?? null,
        });
      }
      if (!body.has_more || !body.last_id) break;
      after = body.last_id;
    }
    return models;
  };

  return {
    async verifyKey(provider, apiKey) {
      switch (provider) {
        case "anthropic": {
          const url = `${CATALOG_ENDPOINTS.anthropic}?limit=1`;
          await get(url, provider, apiKey, AnthropicPage);
          return;
        }
        case "openai":
          await get(CATALOG_ENDPOINTS.openai, provider, apiKey, OpenAiList);
          return;
        case "openrouter":
          // L'elenco dei modelli di OpenRouter è pubblico: la chiave si verifica su /key.
          await get(CATALOG_ENDPOINTS.openrouterKey, provider, apiKey, z.object({}).loose());
          return;
      }
    },

    async listModels(provider, apiKey) {
      switch (provider) {
        case "anthropic":
          return anthropic(apiKey);
        case "openai": {
          // OpenAI non dichiara le capacità dei modelli nel suo elenco.
          const body = await get(CATALOG_ENDPOINTS.openai, provider, apiKey, OpenAiList);
          return body.data
            .map((m) => ({ id: m.id, label: m.id, supportsImages: null, supportsPdf: null }))
            .sort((a, b) => a.id.localeCompare(b.id));
        }
        case "openrouter": {
          const body = await get(CATALOG_ENDPOINTS.openrouter, provider, apiKey, OpenRouterList);
          // Solo i modelli che accettano immagini in input (sezione 7).
          return body.data
            .filter((m) => m.architecture?.input_modalities?.includes("image"))
            .map((m) => ({
              id: m.id,
              label: m.name ?? m.id,
              supportsImages: true,
              supportsPdf: m.architecture?.input_modalities?.includes("file") ?? false,
            }));
        }
      }
    },
  };
}

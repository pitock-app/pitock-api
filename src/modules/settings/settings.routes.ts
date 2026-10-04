import { createRoute } from "@hono/zod-openapi";
import {
  commonErrors,
  ErrorResponse,
  jsonResponse,
  notFoundError,
  security,
} from "../../shared/openapi.js";
import { createRouter } from "../../shared/router.js";
import {
  AiSettings,
  AiSettingsInput,
  AiTestBody,
  AiTestResult,
  ApiKeyBody,
  ApiKeyInfo,
  ModelsQuery,
  ModelsResponse,
  ProviderParam,
} from "./settings.schemas.js";

const tags = ["settings"];
const body = <T>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
const keyMissing = {
  409: jsonResponse(ErrorResponse, "Nessuna chiave salvata per il provider (USER_KEY_MISSING)"),
} as const;
const providerErrors = {
  422: jsonResponse(ErrorResponse, "Chiave rifiutata (USER_KEY_INVALID) o senza quota"),
  502: jsonResponse(ErrorResponse, "Provider non raggiungibile (PROVIDER_UNAVAILABLE)"),
} as const;

const getSettings = createRoute({
  method: "get",
  path: "/v1/settings/ai",
  tags,
  security,
  summary: "Impostazioni AI, chiavi salvate (solo last4) e quota della piattaforma",
  responses: { 200: jsonResponse(AiSettings, "Impostazioni AI"), ...commonErrors },
});

const putSettings = createRoute({
  method: "put",
  path: "/v1/settings/ai",
  tags,
  security,
  summary: "Modalità (platform/byok), provider, modello e fallback sulla piattaforma",
  request: { body: body(AiSettingsInput) },
  responses: {
    200: jsonResponse(AiSettings, "Impostazioni aggiornate"),
    ...keyMissing,
    ...commonErrors,
  },
});

const putKey = createRoute({
  method: "put",
  path: "/v1/settings/ai/keys/{provider}",
  tags,
  security,
  summary: "Verifica la chiave sul provider, poi la cifra e la salva",
  request: { params: ProviderParam, body: body(ApiKeyBody) },
  responses: {
    200: jsonResponse(ApiKeyInfo, "Chiave salvata"),
    ...providerErrors,
    ...commonErrors,
  },
});

const deleteKey = createRoute({
  method: "delete",
  path: "/v1/settings/ai/keys/{provider}",
  tags,
  security,
  summary: "Cancella la chiave; se era in uso torna a mode=platform",
  request: { params: ProviderParam },
  responses: { 204: { description: "Chiave cancellata" }, ...notFoundError, ...commonErrors },
});

const test = createRoute({
  method: "post",
  path: "/v1/settings/ai/test",
  tags,
  security,
  summary: "Prova chiave e modello con una chiamata minima",
  request: { body: body(AiTestBody) },
  responses: {
    200: jsonResponse(AiTestResult, "Esito della prova"),
    ...keyMissing,
    422: jsonResponse(ErrorResponse, "Chiave salvata non decifrabile (USER_KEY_INVALID)"),
    ...commonErrors,
  },
});

const models = createRoute({
  method: "get",
  path: "/v1/settings/ai/models",
  tags,
  security,
  summary: "Modelli del provider, caricati in tempo reale",
  request: { query: ModelsQuery },
  responses: {
    200: jsonResponse(ModelsResponse, "Modelli disponibili"),
    ...keyMissing,
    ...providerErrors,
    ...commonErrors,
  },
});

export const settingsRoutes = () =>
  createRouter()
    .openapi(getSettings, async (c) => {
      const res = await c.get("container").settings.get(c.get("userId"));
      return c.json(res, 200);
    })
    .openapi(putSettings, async (c) => {
      const res = await c.get("container").settings.update(c.get("userId"), c.req.valid("json"));
      return c.json(res, 200);
    })
    .openapi(putKey, async (c) => {
      const res = await c
        .get("container")
        .settings.putKey(
          c.get("userId"),
          c.req.valid("param").provider,
          c.req.valid("json").apiKey,
        );
      return c.json(res, 200);
    })
    .openapi(deleteKey, async (c) => {
      await c.get("container").settings.deleteKey(c.get("userId"), c.req.valid("param").provider);
      return c.body(null, 204);
    })
    .openapi(test, async (c) => {
      const res = await c.get("container").models.test(c.get("userId"), c.req.valid("json"));
      return c.json(res, 200);
    })
    .openapi(models, async (c) => {
      const res = await c
        .get("container")
        .models.list(c.get("userId"), c.req.valid("query").provider);
      return c.json(res, 200);
    });

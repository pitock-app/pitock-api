import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAiSdkLlm } from "../../src/infra/llm/ai-sdk.adapter.js";
import {
  CATALOG_ENDPOINTS,
  createModelCatalog,
} from "../../src/infra/llm/model-catalog.adapter.js";
import { LlmError } from "../../src/ports/llm.port.js";
import { parseRangeEnd } from "../../src/shared/dates.js";

const KEY = "sk-ant-secret-key-000000000";

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** `fetch` finto: risponde con i corpi accodati e registra URL e header. */
const fakeFetch = (...responses: (Response | Error)[]) => {
  const seen: Seen[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift();
    if (!next) return Promise.reject(new Error("nessuna risposta"));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fn, seen };
};

const ok = (body: unknown) => Response.json(body);

const kind = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LlmError);
  expect((err as Error).message).not.toContain(KEY);
  return (err as LlmError).kind;
};

describe("catalogo dei modelli", () => {
  it("Anthropic: header, paginazione e capacità dichiarate", async () => {
    const { fn, seen } = fakeFetch(
      ok({
        data: [
          {
            id: "m1",
            display_name: "Modello 1",
            capabilities: { image_input: { supported: true }, pdf_input: { supported: false } },
          },
        ],
        has_more: true,
        last_id: "m1",
      }),
      ok({ data: [{ id: "m2", capabilities: null }], has_more: false, last_id: "m2" }),
    );
    const models = await createModelCatalog(fn).listModels("anthropic", KEY);
    expect(models).toEqual([
      { id: "m1", label: "Modello 1", supportsImages: true, supportsPdf: false },
      { id: "m2", label: "m2", supportsImages: null, supportsPdf: null },
    ]);
    expect(seen[0]?.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
    expect(seen[1]?.url).toContain("after_id=m1");
  });

  it("OpenAI: capacità non dichiarate (null), bearer token", async () => {
    const { fn, seen } = fakeFetch(ok({ object: "list", data: [{ id: "b" }, { id: "a" }] }));
    const models = await createModelCatalog(fn).listModels("openai", KEY);
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
    expect(models[0]).toMatchObject({ supportsImages: null, supportsPdf: null });
    expect(seen[0]).toEqual({
      url: CATALOG_ENDPOINTS.openai,
      headers: { Authorization: `Bearer ${KEY}` },
    });
  });

  it("OpenRouter: elenco pubblico filtrato sui modelli con input immagine", async () => {
    const { fn, seen } = fakeFetch(
      ok({
        data: [
          { id: "v/text", name: "Solo testo", architecture: { input_modalities: ["text"] } },
          { id: "v/img", name: "Immagini", architecture: { input_modalities: ["text", "image"] } },
          { id: "v/pdf", architecture: { input_modalities: ["image", "file"] } },
        ],
      }),
    );
    const models = await createModelCatalog(fn).listModels("openrouter", null);
    expect(models).toEqual([
      { id: "v/img", label: "Immagini", supportsImages: true, supportsPdf: false },
      { id: "v/pdf", label: "v/pdf", supportsImages: true, supportsPdf: true },
    ]);
    expect(seen[0]?.headers).toEqual({});
  });

  it("verifica della chiave: OpenRouter su /key, gli altri sull'elenco", async () => {
    const { fn, seen } = fakeFetch(ok({ data: {} }), ok({ data: [] }), ok({ data: [] }));
    const catalog = createModelCatalog(fn);
    await catalog.verifyKey("openrouter", KEY);
    await catalog.verifyKey("anthropic", KEY);
    await catalog.verifyKey("openai", KEY);
    expect(seen.map((s) => s.url)).toEqual([
      CATALOG_ENDPOINTS.openrouterKey,
      `${CATALOG_ENDPOINTS.anthropic}?limit=1`,
      CATALOG_ENDPOINTS.openai,
    ]);
    expect(seen[0]?.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("classifica gli errori senza riportare la chiave", async () => {
    const run = (r: Response | Error) =>
      kind(createModelCatalog(fakeFetch(r).fn).verifyKey("openai", KEY));
    expect(await run(new Response(KEY, { status: 401 }))).toBe("auth");
    expect(await run(new Response(KEY, { status: 403 }))).toBe("auth");
    expect(await run(new Response(KEY, { status: 429 }))).toBe("quota");
    expect(await run(new Response(KEY, { status: 500 }))).toBe("unavailable");
    expect(await run(new Error(`rete giù ${KEY}`))).toBe("unavailable");
    expect(await run(new Response("non json"))).toBe("unavailable");
    expect(await run(ok({ data: "x" }))).toBe("unavailable");
  });
});

describe("ping dell'adapter AI SDK", () => {
  it("chiamata minima con i token usati", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      },
    });
    const res = await createAiSdkLlm(() => model).ping({
      provider: "openai",
      model: "m",
      apiKey: KEY,
    });
    expect(res.usage).toEqual({ inputTokens: 8, outputTokens: 1, totalTokens: 9 });
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(16);
  });

  it("errore HTTP 401 → auth", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          new APICallError({
            message: "unauthorized",
            url: "https://x.test",
            requestBodyValues: {},
            statusCode: 401,
          }),
        ),
    });
    expect(
      await kind(createAiSdkLlm(() => model).ping({ provider: "openai", model: "m", apiKey: KEY })),
    ).toBe("auth");
  });
});

describe("parseRangeEnd", () => {
  it("con la sola data: inizio del giorno dopo a Roma, anche al cambio dell'ora", () => {
    expect(parseRangeEnd("2026-10-04")?.toISOString()).toBe("2026-10-04T22:00:00.000Z");
    expect(parseRangeEnd("2026-10-24")?.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(parseRangeEnd("2026-10-25")?.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(parseRangeEnd("2026-12-31")?.toISOString()).toBe("2026-12-31T23:00:00.000Z");
  });

  it("con data e ora: l'istante è incluso", () => {
    expect(parseRangeEnd("2026-10-04T10:00:00Z")?.toISOString()).toBe("2026-10-04T10:00:00.001Z");
  });

  it("date non valide → null", () => {
    expect(parseRangeEnd("2026-02-30")).toBeNull();
    expect(parseRangeEnd("ieri")).toBeNull();
  });
});

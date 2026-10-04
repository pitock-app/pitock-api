import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LlmError } from "../../src/ports/llm.port.js";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { runJobs, uploaded } from "../helpers/extraction.js";
import { usage, validOutput } from "../helpers/fakes.js";

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(() => h.close());
beforeEach(() => {
  h.queue.clear();
  h.llm.reset();
  h.catalog.rejected.clear();
});

const OPENAI_KEY = "sk-proj-user-openai-secret-ABCD1234";
const ANTHROPIC_KEY = "sk-ant-api03-user-anthropic-secret-WXYZ";

interface Settings {
  mode: string;
  provider: string | null;
  model: string | null;
  fallbackToPlatform: boolean;
  keys: { provider: string; last4: string; verifiedAt: string | null }[];
  platformQuota: { used: number; limit: number };
}

const errorCode = async (res: Response) =>
  (await json<{ error: { code: string } }>(res)).error.code;

const saveKey = (user: string, provider: string, apiKey: string) =>
  h.call(user, "PUT", `/v1/settings/ai/keys/${provider}`, { apiKey });

describe("GET/PUT /v1/settings/ai", () => {
  it("senza impostazioni: piattaforma, nessuna chiave, quota", async () => {
    const user = await h.t.createUser();
    const res = await h.call(user, "GET", "/v1/settings/ai");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      mode: "platform",
      provider: null,
      model: null,
      fallbackToPlatform: false,
      keys: [],
      platformQuota: { used: 0, limit: 100 },
    });
  });

  it("byok senza chiave salvata → 409 USER_KEY_MISSING", async () => {
    const user = await h.t.createUser();
    const res = await h.call(user, "PUT", "/v1/settings/ai", {
      mode: "byok",
      provider: "openai",
      model: "model-a",
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("USER_KEY_MISSING");
  });

  it("byok senza modello → 400", async () => {
    const user = await h.t.createUser();
    expect((await saveKey(user, "openai", OPENAI_KEY)).status).toBe(200);
    const res = await h.call(user, "PUT", "/v1/settings/ai", { mode: "byok", provider: "openai" });
    expect(res.status).toBe(400);
  });

  it("salva byok; i campi omessi restano invariati", async () => {
    const user = await h.t.createUser();
    await saveKey(user, "openai", OPENAI_KEY);
    let res = await h.call(user, "PUT", "/v1/settings/ai", {
      mode: "byok",
      provider: "openai",
      model: "model-a",
      fallbackToPlatform: true,
    });
    expect(res.status).toBe(200);
    expect(await json<Settings>(res)).toMatchObject({
      mode: "byok",
      provider: "openai",
      model: "model-a",
      fallbackToPlatform: true,
    });
    res = await h.call(user, "PUT", "/v1/settings/ai", { mode: "platform" });
    expect(await json<Settings>(res)).toMatchObject({
      mode: "platform",
      provider: "openai",
      model: "model-a",
      fallbackToPlatform: true,
    });
    const me = await json<{ ai: { mode: string } }>(await h.call(user, "GET", "/v1/me"));
    expect(me.ai.mode).toBe("platform");
  });

  it("provider o modello non validi → 400", async () => {
    const user = await h.t.createUser();
    for (const body of [
      { mode: "byok", provider: "gemini", model: "x" },
      { mode: "byok", provider: "openai", model: "spazi non ammessi" },
      { mode: "altro" },
    ]) {
      expect((await h.call(user, "PUT", "/v1/settings/ai", body)).status).toBe(400);
    }
  });
});

describe("chiavi BYOK", () => {
  it("verifica la chiave, la cifra e restituisce solo last4", async () => {
    const user = await h.t.createUser();
    const res = await saveKey(user, "openai", OPENAI_KEY);
    expect(res.status).toBe(200);
    const body = await json<{ provider: string; last4: string; verifiedAt: string }>(res);
    expect(body).toMatchObject({ provider: "openai", last4: "1234" });
    expect(Number.isNaN(Date.parse(body.verifiedAt))).toBe(false);
    expect(h.catalog.verified.at(-1)).toEqual({ provider: "openai", apiKey: OPENAI_KEY });

    const [row] = await h.t.query<{ ciphertext: string; last4: string }>(
      `select ciphertext, last4 from user_api_keys where user_id = '${user}'`,
    );
    expect(row?.last4).toBe("1234");
    expect(row?.ciphertext).not.toContain(OPENAI_KEY);
    expect(Buffer.from(row?.ciphertext ?? "", "base64").toString("utf8")).not.toContain("sk-");

    const settings = await json<Settings>(await h.call(user, "GET", "/v1/settings/ai"));
    expect(settings.keys).toEqual([body]);
  });

  it("chiave rifiutata dal provider → 422 USER_KEY_INVALID, non salvata", async () => {
    const user = await h.t.createUser();
    h.catalog.rejected.set(OPENAI_KEY, new LlmError("auth", "401"));
    const res = await saveKey(user, "openai", OPENAI_KEY);
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("USER_KEY_INVALID");
    expect(await h.t.query(`select 1 from user_api_keys where user_id = '${user}'`)).toEqual([]);
  });

  it("provider non raggiungibile → 502 PROVIDER_UNAVAILABLE", async () => {
    const user = await h.t.createUser();
    h.catalog.rejected.set(OPENAI_KEY, new LlmError("unavailable", "500"));
    const res = await saveKey(user, "openai", OPENAI_KEY);
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe("PROVIDER_UNAVAILABLE");
  });

  it("chiave troppo corta o provider sconosciuto → 400", async () => {
    const user = await h.t.createUser();
    expect((await saveKey(user, "openai", "sk-short")).status).toBe(400);
    expect((await saveKey(user, "gemini", OPENAI_KEY)).status).toBe(400);
    expect(h.catalog.verified.some((v) => v.apiKey === "sk-short")).toBe(false);
  });

  it("salvare di nuovo sostituisce la chiave del provider", async () => {
    const user = await h.t.createUser();
    await saveKey(user, "openai", OPENAI_KEY);
    await saveKey(user, "openai", "sk-proj-another-openai-secret-9876");
    const settings = await json<Settings>(await h.call(user, "GET", "/v1/settings/ai"));
    expect(settings.keys.map((k) => k.last4)).toEqual(["9876"]);
  });

  it("cancellare la chiave in uso riporta a mode=platform", async () => {
    const user = await h.t.createUser();
    await saveKey(user, "openai", OPENAI_KEY);
    await saveKey(user, "anthropic", ANTHROPIC_KEY);
    await h.call(user, "PUT", "/v1/settings/ai", {
      mode: "byok",
      provider: "openai",
      model: "model-a",
    });
    // La chiave di un altro provider non tocca la modalità.
    expect((await h.call(user, "DELETE", "/v1/settings/ai/keys/anthropic")).status).toBe(204);
    let s = await json<Settings>(await h.call(user, "GET", "/v1/settings/ai"));
    expect(s.mode).toBe("byok");
    expect((await h.call(user, "DELETE", "/v1/settings/ai/keys/openai")).status).toBe(204);
    s = await json<Settings>(await h.call(user, "GET", "/v1/settings/ai"));
    expect(s).toMatchObject({ mode: "platform", keys: [] });
  });

  it("cancellare una chiave inesistente → 404", async () => {
    const user = await h.t.createUser();
    expect((await h.call(user, "DELETE", "/v1/settings/ai/keys/openai")).status).toBe(404);
  });
});

describe("POST /v1/settings/ai/test", () => {
  it("con la chiave data: ok e chiamata key_test in llm_usage", async () => {
    const user = await h.t.createUser();
    h.llm.respond({ output: null, usage: usage(10, 2) });
    const res = await h.call(user, "POST", "/v1/settings/ai/test", {
      provider: "openai",
      model: "model-a",
      apiKey: OPENAI_KEY,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(h.llm.pings[0]).toEqual({ provider: "openai", model: "model-a", apiKey: OPENAI_KEY });
    const rows = await h.t.query<Record<string, unknown>>(
      `select operation, key_source, success, total_tokens from llm_usage where user_id = '${user}'`,
    );
    expect(rows).toEqual([
      { operation: "key_test", key_source: "user", success: true, total_tokens: 12 },
    ]);
  });

  it("senza chiave usa quella salvata", async () => {
    const user = await h.t.createUser();
    await saveKey(user, "anthropic", ANTHROPIC_KEY);
    h.llm.respond({ output: null, usage: usage(10, 2) });
    const res = await h.call(user, "POST", "/v1/settings/ai/test", {
      provider: "anthropic",
      model: "model-a",
    });
    expect(await json(res)).toEqual({ ok: true });
    expect(h.llm.pings[0]?.apiKey).toBe(ANTHROPIC_KEY);
  });

  it("chiave rifiutata → ok=false con USER_KEY_INVALID, registrata come fallita", async () => {
    const user = await h.t.createUser();
    h.llm.respond(new LlmError("auth", "401"));
    const res = await h.call(user, "POST", "/v1/settings/ai/test", {
      provider: "openai",
      model: "model-a",
      apiKey: OPENAI_KEY,
    });
    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; error: { code: string } }>(res);
    expect(body).toMatchObject({ ok: false, error: { code: "USER_KEY_INVALID" } });
    const [row] = await h.t.query<{ success: boolean; error_code: string }>(
      `select success, error_code from llm_usage where user_id = '${user}'`,
    );
    expect(row).toEqual({ success: false, error_code: "USER_KEY_INVALID" });
  });

  it("senza chiave né chiave salvata → 409 USER_KEY_MISSING", async () => {
    const user = await h.t.createUser();
    const res = await h.call(user, "POST", "/v1/settings/ai/test", {
      provider: "openai",
      model: "model-a",
    });
    expect(res.status).toBe(409);
    expect(h.llm.pings).toHaveLength(0);
  });
});

describe("GET /v1/settings/ai/models", () => {
  it("usa la chiave salvata dell'utente", async () => {
    const user = await h.t.createUser();
    await saveKey(user, "openai", OPENAI_KEY);
    const res = await h.call(user, "GET", "/v1/settings/ai/models?provider=openai");
    expect(res.status).toBe(200);
    const body = await json<{ models: { id: string }[] }>(res);
    expect(body.models.map((m) => m.id)).toEqual(["model-a", "model-b"]);
    expect(h.catalog.listed.at(-1)).toEqual({ provider: "openai", apiKey: OPENAI_KEY });
  });

  it("OpenRouter senza chiave usa l'elenco pubblico", async () => {
    const user = await h.t.createUser();
    const res = await h.call(user, "GET", "/v1/settings/ai/models?provider=openrouter");
    expect(res.status).toBe(200);
    expect(h.catalog.listed.at(-1)).toEqual({ provider: "openrouter", apiKey: null });
  });

  it("senza chiave per Anthropic/OpenAI → 409; provider mancante → 400", async () => {
    const user = await h.t.createUser();
    const res = await h.call(user, "GET", "/v1/settings/ai/models?provider=anthropic");
    expect(res.status).toBe(409);
    expect((await h.call(user, "GET", "/v1/settings/ai/models")).status).toBe(400);
  });
});

describe("nessuna risposta di /v1/settings/* contiene la chiave", () => {
  it("su tutte le rotte, anche in errore", async () => {
    const user = await h.t.createUser();
    const bodies: string[] = [];
    const record = async (res: Promise<Response>) => {
      bodies.push(await (await res).text());
    };
    await record(saveKey(user, "openai", OPENAI_KEY));
    await record(saveKey(user, "anthropic", ANTHROPIC_KEY));
    await record(
      h.call(user, "PUT", "/v1/settings/ai", { mode: "byok", provider: "openai", model: "m" }),
    );
    await record(h.call(user, "GET", "/v1/settings/ai"));
    await record(h.call(user, "GET", "/v1/settings/ai/models?provider=openai"));
    h.llm.respond({ output: null, usage: usage() }, new LlmError("auth", "401"));
    await record(h.call(user, "POST", "/v1/settings/ai/test", { provider: "openai", model: "m" }));
    await record(
      h.call(user, "POST", "/v1/settings/ai/test", {
        provider: "anthropic",
        model: "m",
        apiKey: ANTHROPIC_KEY,
      }),
    );
    h.catalog.rejected.set(OPENAI_KEY, new LlmError("auth", "401"));
    await record(saveKey(user, "openai", OPENAI_KEY));
    await record(h.call(user, "GET", "/v1/settings/ai/models?provider=openai"));
    await record(h.call(user, "GET", "/v1/me"));
    await record(h.call(user, "DELETE", "/v1/settings/ai/keys/anthropic"));

    for (const b of bodies) {
      for (const key of [OPENAI_KEY, ANTHROPIC_KEY]) {
        expect(b).not.toContain(key);
        expect(b).not.toContain(key.slice(0, -4));
      }
      expect(b).not.toMatch(/ciphertext|authTag|auth_tag|"iv"/);
    }
  });
});

describe("cambiare il modello cambia quello dell'estrazione successiva", () => {
  it("model-a poi model-b", async () => {
    const user = await h.t.createUser();
    await saveKey(user, "openai", OPENAI_KEY);
    for (const model of ["model-a", "model-b"]) {
      await h.call(user, "PUT", "/v1/settings/ai", { mode: "byok", provider: "openai", model });
      await uploaded(h, user);
      h.llm.respond({ output: validOutput(), usage: usage() });
      await runJobs(h);
      expect(h.llm.requests.at(-1)).toMatchObject({
        provider: "openai",
        model,
        apiKey: OPENAI_KEY,
      });
    }
  });

  it("tornare a platform usa di nuovo il modello della piattaforma", async () => {
    const user = await h.t.createUser();
    await saveKey(user, "openai", OPENAI_KEY);
    await h.call(user, "PUT", "/v1/settings/ai", {
      mode: "byok",
      provider: "openai",
      model: "model-a",
    });
    await h.call(user, "PUT", "/v1/settings/ai", { mode: "platform" });
    await uploaded(h, user);
    h.llm.respond({ output: validOutput(), usage: usage() });
    await runJobs(h);
    expect(h.llm.requests.at(-1)).toMatchObject({
      provider: h.env.DEFAULT_PROVIDER,
      model: h.env.DEFAULT_MODEL,
      apiKey: h.env.PLATFORM_API_KEY,
    });
  });
});

describe("isolamento delle impostazioni", () => {
  it("B non vede né usa le chiavi di A", async () => {
    const a = await h.t.createUser();
    const b = await h.t.createUser();
    await saveKey(a, "openai", OPENAI_KEY);
    const s = await json<Settings>(await h.call(b, "GET", "/v1/settings/ai"));
    expect(s.keys).toEqual([]);
    expect((await h.call(b, "DELETE", "/v1/settings/ai/keys/openai")).status).toBe(404);
    expect((await h.call(b, "GET", "/v1/settings/ai/models?provider=openai")).status).toBe(409);
    const res = await h.call(b, "PUT", "/v1/settings/ai", {
      mode: "byok",
      provider: "openai",
      model: "model-a",
    });
    expect(res.status).toBe(409);
    const sa = await json<Settings>(await h.call(a, "GET", "/v1/settings/ai"));
    expect(sa.keys).toHaveLength(1);
  });
});

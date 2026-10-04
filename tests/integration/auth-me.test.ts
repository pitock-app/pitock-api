import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userAiSettings } from "../../src/infra/db/schema/index.js";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { seedExtractedFile } from "../helpers/seed.js";

let h: TestApp;
let user: string;

beforeAll(async () => {
  h = await createTestApp();
  user = await h.t.createUser();
});
afterAll(() => h.close());

const get = (headers: Record<string, string>) => h.app.request("/v1/me", { headers });

describe("autenticazione su /v1/*", () => {
  it("senza token → 401 nel formato comune con request id", async () => {
    const res = await get({});
    expect(res.status).toBe(401);
    const body = await json<{ error: { code: string; message: string; requestId: string } }>(res);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.requestId).toBe(res.headers.get("X-Request-Id"));
  });

  it.each([
    ["issuer errato", { issuer: "https://altro.supabase.co/auth/v1" }],
    ["audience errata", { audience: "anon" }],
    ["token scaduto", { expiresIn: "-1m" }],
  ])("%s → 401", async (_, opts) => {
    const res = await get({ Authorization: `Bearer ${await h.auth.token(user, opts)}` });
    expect(res.status).toBe(401);
  });

  it("firma con una chiave estranea → 401", async () => {
    const res = await get({ Authorization: `Bearer ${await h.auth.foreignToken(user)}` });
    expect(res.status).toBe(401);
  });

  it("schema diverso da Bearer → 401", async () => {
    expect((await get({ Authorization: "Basic abc" })).status).toBe(401);
  });

  it("le rotte pubbliche non richiedono il token", async () => {
    expect((await h.app.request("/health")).status).toBe(200);
    expect((await h.app.request("/openapi.json")).status).toBe(200);
  });

  it("una rotta /v1 inesistente senza token → 401 (nessuna enumerazione)", async () => {
    expect((await h.app.request("/v1/nope")).status).toBe(401);
  });
});

describe("GET /v1/me", () => {
  it("utente senza impostazioni: modalità platform con il modello di default", async () => {
    const res = await h.call(user, "GET", "/v1/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: user,
      email: `${user.slice(0, 8)}@example.test`,
      ai: { mode: "platform", provider: "anthropic", model: "fake-model" },
      platformQuota: { used: 0, limit: 100 },
    });
  });

  it("conta le estrazioni di piattaforma del mese e mostra le impostazioni BYOK", async () => {
    const u = await h.t.createUser();
    h.clock.set(new Date().toISOString());
    await seedExtractedFile(h.t.db, u);
    await seedExtractedFile(h.t.db, u);
    await h.t.db
      .insert(userAiSettings)
      .values({ userId: u, mode: "byok", provider: "openai", model: "m-1" });
    const body = await json<{ ai: unknown; platformQuota: { used: number } }>(
      await h.call(u, "GET", "/v1/me"),
    );
    expect(body.ai).toEqual({ mode: "byok", provider: "openai", model: "m-1" });
    expect(body.platformQuota.used).toBe(2);
  });
});

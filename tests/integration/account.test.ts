import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { recomputeStatsJob } from "../../src/jobs/recompute-stats.job.js";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { JPEG } from "../helpers/fakes.js";
import { seedAiSettings, seedExtractedFile } from "../helpers/seed.js";

let h: TestApp | undefined;
let a: string;
let b: string;
let aPaths: string[];
let bPath: string;

const USER_TABLES = [
  "receipts_raw",
  "extractions",
  "receipt_items",
  "llm_usage",
  "user_ai_settings",
  "user_api_keys",
  "stats_monthly",
] as const;

const app = () => {
  if (!h) throw new Error("app di test non inizializzata");
  return h;
};

const countRows = async (userId: string) => {
  const out: Record<string, number> = {};
  for (const table of USER_TABLES) {
    const [row] = await app().t.query<{ n: number }>(
      `select count(*)::int as n from ${table} where user_id = '${userId}'`,
    );
    out[table] = row?.n ?? 0;
  }
  return out;
};

const authUserExists = async (userId: string) =>
  (await app().t.query(`select 1 from auth.users where id = '${userId}'`)).length > 0;

/** Due utenti con scontrini (file e manuale), file in Storage, impostazioni, chiave e statistiche. */
async function setup() {
  await h?.close();
  h = await createTestApp();
  const t = h;
  a = await t.t.createUser();
  b = await t.t.createUser();
  const seededA = await seedExtractedFile(t.t.db, a);
  const seededB = await seedExtractedFile(t.t.db, b);
  const pathA = seededA.receipt.storagePath ?? "";
  bPath = seededB.receipt.storagePath ?? "";
  t.storage.put(pathA, JPEG(), "image/jpeg");
  t.storage.put(bPath, JPEG(), "image/jpeg");
  // Upload in sospeso: anche il suo file va cancellato.
  const res = await t.call(a, "POST", "/v1/receipts/upload-url", {
    source: "camera",
    sha256: "c".repeat(64),
    mimeType: "image/jpeg",
    sizeBytes: 1024,
  });
  const pending = await json<{ path: string }>(res);
  t.storage.put(pending.path, JPEG(), "image/jpeg");
  aPaths = [pathA, pending.path];
  await t.call(a, "POST", "/v1/receipts/manual", {
    merchantName: "Bar Sport",
    purchasedAt: "2026-10-01T08:15:00+02:00",
    total: 4.5,
    paymentMethod: "contanti",
    category: "ristorazione",
    items: [{ description: "Caffè", amount: 4.5 }],
  });
  await seedAiSettings(t.t.db, t.env, a, {
    mode: "byok",
    provider: "openai",
    model: "model-a",
    apiKey: "sk-test-0123456789abcdef",
  });
  const job = recomputeStatsJob(t.container.stats);
  await job({ userId: a });
  await job({ userId: b });
}

beforeEach(setup);
afterAll(() => h?.close());

describe("DELETE /v1/account", () => {
  it("cancella file, righe e utente di Supabase Auth", async () => {
    const t = app();
    const before = await countRows(a);
    for (const table of USER_TABLES) expect(before[table], table).toBeGreaterThan(0);

    const res = await t.call(a, "DELETE", "/v1/account", { confirm: "ELIMINA" });
    expect(res.status).toBe(204);

    for (const p of aPaths) expect(t.storage.objects.has(p), p).toBe(false);
    expect(Object.values(await countRows(a)).every((n) => n === 0)).toBe(true);
    expect(t.users.deleted).toEqual([a]);
    expect(await authUserExists(a)).toBe(false);
  });

  it("cancella anche i file senza riga (upload arrivati con un URL firmato già emesso)", async () => {
    const t = app();
    const orphan = `${a}/00000000-0000-4000-8000-000000000000.jpg`;
    t.storage.put(orphan, JPEG(), "image/jpeg");
    // L'upload arriva mentre la cancellazione è in corso, dopo la rimozione dei file.
    const deleteUser = t.users.deleteUser.bind(t.users);
    t.users.deleteUser = async (id) => {
      t.storage.put(`${a}/late.jpg`, JPEG(), "image/jpeg");
      await deleteUser(id);
    };
    expect((await t.call(a, "DELETE", "/v1/account", { confirm: "ELIMINA" })).status).toBe(204);
    expect([...t.storage.objects.keys()].filter((p) => p.startsWith(`${a}/`))).toEqual([]);
    expect(t.storage.objects.has(bPath)).toBe(true);
  });

  it("non tocca i dati degli altri utenti", async () => {
    const t = app();
    const before = await countRows(b);
    await t.call(a, "DELETE", "/v1/account", { confirm: "ELIMINA" });
    expect(await countRows(b)).toEqual(before);
    expect(t.storage.objects.has(bPath)).toBe(true);
    expect(await authUserExists(b)).toBe(true);
  });

  it.each([
    ["senza corpo", undefined],
    ["conferma sbagliata", { confirm: "elimina" }],
    ["conferma mancante", {}],
  ])("rifiuta la richiesta %s", async (_, body) => {
    const t = app();
    const res = await t.call(a, "DELETE", "/v1/account", body);
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("VALIDATION_ERROR");
    expect((await countRows(a)).receipts_raw).toBeGreaterThan(0);
    expect(t.users.deleted).toEqual([]);
    for (const p of aPaths) expect(t.storage.objects.has(p)).toBe(true);
  });

  it("richiede l'autenticazione", async () => {
    const res = await app().app.request("/v1/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "ELIMINA" }),
    });
    expect(res.status).toBe(401);
  });

  it("se Storage fallisce non cancella nulla e la richiesta si può ripetere", async () => {
    const t = app();
    const remove = t.storage.remove.bind(t.storage);
    t.storage.remove = () => Promise.reject(new Error("storage giù"));
    const res = await t.call(a, "DELETE", "/v1/account", { confirm: "ELIMINA" });
    expect(res.status).toBe(500);
    expect((await countRows(a)).receipts_raw).toBeGreaterThan(0);
    expect(await authUserExists(a)).toBe(true);

    t.storage.remove = remove;
    expect((await t.call(a, "DELETE", "/v1/account", { confirm: "ELIMINA" })).status).toBe(204);
    expect(await authUserExists(a)).toBe(false);
  });

  it("se Supabase Auth fallisce i dati sono già cancellati e la richiesta si può ripetere", async () => {
    const t = app();
    t.users.fail = true;
    expect((await t.call(a, "DELETE", "/v1/account", { confirm: "ELIMINA" })).status).toBe(500);
    expect((await countRows(a)).receipts_raw).toBe(0);
    expect(await authUserExists(a)).toBe(true);

    t.users.fail = false;
    expect((await t.call(a, "DELETE", "/v1/account", { confirm: "ELIMINA" })).status).toBe(204);
    expect(await authUserExists(a)).toBe(false);
  });
});

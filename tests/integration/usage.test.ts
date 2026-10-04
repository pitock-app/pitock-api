import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { llmUsage, modelPrices } from "../../src/infra/db/schema/index.js";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { seedExtractedFile } from "../helpers/seed.js";

let h: TestApp;
let a: string;
let b: string;
let receiptId: string;

interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unpricedCalls: number;
}

interface Summary {
  from: string;
  to: string;
  totals: Totals;
  series: (Totals & { key: string })[];
  byModel: (Totals & { provider: string; model: string })[];
}

interface Calls {
  items: { id: string; operation: string; merchantName: string | null; costUsd: number | null }[];
  nextCursor: string | null;
}

const call = (o: Partial<typeof llmUsage.$inferInsert> & { createdAt: Date }) => ({
  userId: a,
  operation: "extract" as const,
  provider: "openai",
  model: "model-a",
  keySource: "user" as const,
  inputTokens: 1000,
  outputTokens: 100,
  totalTokens: 1100,
  latencyMs: 500,
  success: true,
  ...o,
});

beforeAll(async () => {
  h = await createTestApp();
  h.clock.set("2026-10-20T12:00:00Z");
  a = await h.t.createUser();
  b = await h.t.createUser();
  // seedExtractedFile aggiunge una chiamata anthropic/fake-model senza costo: la sposto fuori dal mese.
  const seeded = await seedExtractedFile(h.t.db, a, { merchantName: "Bar Sport" });
  receiptId = seeded.receipt.id;
  await h.t.query(`update llm_usage set created_at = '2026-08-01T10:00:00Z'`);
  await h.t.db.insert(modelPrices).values({
    provider: "openai",
    model: "model-b",
    inputPerMtokUsd: 2,
    outputPerMtokUsd: 10,
  });
  await h.t.db.insert(llmUsage).values([
    // 3 ottobre: cost_usd salvato.
    call({ createdAt: new Date("2026-10-03T08:00:00Z"), costUsd: 0.5, receiptId }),
    // 22:30Z del 3 ottobre = 4 ottobre a Roma. Senza cost_usd ma con prezzo in model_prices.
    call({ createdAt: new Date("2026-10-03T22:30:00Z"), model: "model-b" }),
    // Senza prezzo: non entra nel costo.
    call({
      createdAt: new Date("2026-10-04T09:00:00Z"),
      model: "model-c",
      success: false,
      errorCode: "USER_KEY_INVALID",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    }),
    call({
      createdAt: new Date("2026-10-05T09:00:00Z"),
      operation: "key_test",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      costUsd: 0.000012,
    }),
    // Settembre: fuori dall'intervallo di default.
    call({ createdAt: new Date("2026-09-15T09:00:00Z"), costUsd: 1 }),
    // Utente B: mai nei totali di A.
    call({ userId: b, createdAt: new Date("2026-10-03T09:00:00Z"), costUsd: 7 }),
  ]);
});
afterAll(() => h.close());

describe("GET /v1/usage", () => {
  it("di default: dal primo del mese a adesso, serie per giorno in Europe/Rome", async () => {
    const res = await h.call(a, "GET", "/v1/usage");
    expect(res.status).toBe(200);
    const s = await json<Summary>(res);
    expect(s.from).toBe("2026-09-30T22:00:00.000Z");
    expect(s.totals).toEqual({
      calls: 4,
      inputTokens: 2010,
      outputTokens: 202,
      // 0,5 + (1000·2 + 100·10)/1e6 + 0,000012
      costUsd: 0.503012,
      unpricedCalls: 1,
    });
    expect(s.series.map((p) => [p.key, p.calls])).toEqual([
      ["2026-10-03", 1],
      ["2026-10-04", 2],
      ["2026-10-05", 1],
    ]);
    expect(s.byModel.map((m) => [m.model, m.calls, m.costUsd])).toEqual([
      ["model-a", 2, 0.500012],
      ["model-b", 1, 0.003],
      ["model-c", 1, 0],
    ]);
  });

  it("i totali coincidono con llm_usage", async () => {
    const s = await json<Summary>(
      await h.call(a, "GET", "/v1/usage?from=2026-01-01&to=2026-12-31"),
    );
    const [row] = await h.t.query<{ n: number; i: number; o: number }>(
      `select count(*)::int n, sum(input_tokens)::int i, sum(output_tokens)::int o
       from llm_usage where user_id = '${a}'`,
    );
    expect(s.totals).toMatchObject({ calls: row?.n, inputTokens: row?.i, outputTokens: row?.o });
    expect(s.byModel.reduce((acc, m) => acc + m.calls, 0)).toBe(row?.n);
    expect(s.series.reduce((acc, m) => acc + m.calls, 0)).toBe(row?.n);
  });

  it("groupBy=model: serie per provider/modello", async () => {
    const s = await json<Summary>(await h.call(a, "GET", "/v1/usage?groupBy=model"));
    expect(s.series.map((p) => p.key)).toEqual([
      "openai/model-a",
      "openai/model-b",
      "openai/model-c",
    ]);
  });

  it("to con la sola data comprende tutta la giornata (Roma)", async () => {
    const s = await json<Summary>(
      await h.call(a, "GET", "/v1/usage?from=2026-10-04&to=2026-10-04"),
    );
    expect(s.totals.calls).toBe(2);
  });

  it("intervallo non valido → 400", async () => {
    expect((await h.call(a, "GET", "/v1/usage?from=2026-10-05&to=2026-10-01")).status).toBe(400);
    expect((await h.call(a, "GET", "/v1/usage?from=ieri")).status).toBe(400);
    expect((await h.call(a, "GET", "/v1/usage?groupBy=week")).status).toBe(400);
  });

  it("B vede solo le proprie chiamate", async () => {
    const s = await json<Summary>(await h.call(b, "GET", "/v1/usage"));
    expect(s.totals).toMatchObject({ calls: 1, costUsd: 7 });
  });
});

describe("GET /v1/usage/calls", () => {
  it("pagina con cursore, dalla più recente, con l'esercente collegato", async () => {
    const first = await json<Calls>(await h.call(a, "GET", "/v1/usage/calls?limit=4"));
    expect(first.items.map((c) => c.operation)).toEqual([
      "key_test",
      "extract",
      "extract",
      "extract",
    ]);
    expect(first.items[3]).toMatchObject({ merchantName: "Bar Sport", costUsd: 0.5 });
    expect(first.items[2]).toMatchObject({ merchantName: null, costUsd: 0.003 });
    expect(first.nextCursor).not.toBeNull();

    const second = await json<Calls>(
      await h.call(a, "GET", `/v1/usage/calls?limit=4&cursor=${first.nextCursor ?? ""}`),
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((c) => c.id);
    expect(new Set(ids).size).toBe(6);
  });

  it("B non vede le chiamate di A; cursore non valido → 400", async () => {
    const calls = await json<Calls>(await h.call(b, "GET", "/v1/usage/calls"));
    expect(calls.items).toHaveLength(1);
    expect(calls.items[0]?.merchantName).toBeNull();
    expect((await h.call(a, "GET", "/v1/usage/calls?cursor=xyz")).status).toBe(400);
    expect((await h.call(a, "GET", "/v1/usage/calls?limit=101")).status).toBe(400);
  });
});

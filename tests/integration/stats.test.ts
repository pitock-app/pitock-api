import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractions } from "../../src/infra/db/schema/index.js";
import { recomputeStatsJob } from "../../src/jobs/recompute-stats.job.js";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { seedExtractedFile } from "../helpers/seed.js";

interface Amounts {
  total: number;
  nReceipts: number;
}

interface Stats {
  from: string | null;
  to: string | null;
  granularity: string;
  totals: Amounts & { average: number };
  byCategory: (Amounts & { category: string })[];
  byPeriod: (Amounts & { period: string })[];
  topMerchants: (Amounts & { merchantName: string })[];
  bySource: (Amounts & { source: string })[];
}

interface MonthlyRow {
  month: string;
  category: string;
  total: string;
  n_receipts: number;
}

let h: TestApp;
let a: string;
let b: string;
let lateSeptemberId: string;

/** Somma dei totali delle estrazioni correnti degli scontrini estratti, direttamente in SQL. */
const sqlTotal = async (userId: string) => {
  const [row] = await h.t.query<{ total: string | null; n: number }>(
    `select sum(e.total) as total, count(*)::int as n
       from receipts_raw r join extractions e on e.receipt_id = r.id and e.is_current
      where r.user_id = '${userId}' and r.status = 'extracted'`,
  );
  return { total: Number(row?.total ?? 0), n: row?.n ?? 0 };
};

const monthly = (userId: string) =>
  h.t.query<MonthlyRow>(
    `select month::text as month, category, total::text as total, n_receipts
       from stats_monthly where user_id = '${userId}' order by month, category`,
  );

const getStats = async (userId: string, query = "") => {
  const res = await h.call(userId, "GET", `/v1/stats${query}`);
  expect(res.status).toBe(200);
  return json<Stats>(res);
};

beforeAll(async () => {
  h = await createTestApp();
  a = await h.t.createUser();
  b = await h.t.createUser();

  // Manuale: ottobre 2026, ristorazione.
  const manual = await h.call(a, "POST", "/v1/receipts/manual", {
    merchantName: "Bar Sport",
    purchasedAt: "2026-10-01T08:15:00+02:00",
    total: 4.5,
    paymentMethod: "contanti",
    category: "ristorazione",
  });
  expect(manual.status).toBe(201);
  // File: settembre 2026.
  await seedExtractedFile(h.t.db, a, { merchantName: "Supermercato", total: 12.3 });
  // 30/09 22:30 UTC è già il 1° ottobre a Roma.
  const late = await seedExtractedFile(h.t.db, a, {
    merchantName: "Supermercato",
    total: 20,
    purchasedAt: new Date("2026-09-30T22:30:00Z"),
  });
  lateSeptemberId = late.receipt.id;
  // Senza data d'acquisto, categoria ed esercente: conta la data di caricamento e "altro".
  await seedExtractedFile(h.t.db, a, {
    merchantName: null,
    category: null,
    total: 7,
    purchasedAt: null,
    createdAt: new Date("2025-12-15T10:00:00Z"),
  });
  // Esclusi: scontrino fallito ed estrazione non più corrente.
  await seedExtractedFile(h.t.db, a, { status: "failed", total: 100 });
  await h.t.db.insert(extractions).values({
    receiptId: lateSeptemberId,
    userId: a,
    method: "llm",
    rawJson: {},
    merchantName: "Vecchia lettura",
    total: 999,
    category: "svago",
    isCurrent: false,
  });
  // Altro utente.
  await seedExtractedFile(h.t.db, b, { merchantName: "Negozio di B", total: 50 });
});
afterAll(() => h.close());

describe("GET /v1/stats", () => {
  it("i totali coincidono con la somma delle estrazioni correnti", async () => {
    const s = await getStats(a);
    const expected = await sqlTotal(a);
    expect(s.totals).toEqual({ total: 43.8, nReceipts: 4, average: 10.95 });
    expect(s.totals.total).toBeCloseTo(expected.total, 2);
    expect(s.totals.nReceipts).toBe(expected.n);
    expect(s.from).toBeNull();
    expect(s.to).toBeNull();
  });

  it("raggruppa per categoria, mese, esercente e sorgente", async () => {
    const s = await getStats(a);
    expect(s.granularity).toBe("month");
    expect(s.byCategory).toEqual([
      { category: "alimentari", total: 32.3, nReceipts: 2 },
      { category: "altro", total: 7, nReceipts: 1 },
      { category: "ristorazione", total: 4.5, nReceipts: 1 },
    ]);
    expect(s.byPeriod).toEqual([
      { period: "2025-12", total: 7, nReceipts: 1 },
      { period: "2026-09", total: 12.3, nReceipts: 1 },
      { period: "2026-10", total: 24.5, nReceipts: 2 },
    ]);
    expect(s.topMerchants).toEqual([
      { merchantName: "Supermercato", total: 32.3, nReceipts: 2 },
      { merchantName: "Bar Sport", total: 4.5, nReceipts: 1 },
    ]);
    expect(s.bySource).toEqual([
      { source: "file", total: 39.3, nReceipts: 3 },
      { source: "manual", total: 4.5, nReceipts: 1 },
    ]);
    // Le parti sommano al totale.
    const sum = (xs: Amounts[]) => xs.reduce((acc, x) => acc + x.total, 0);
    expect(sum(s.byCategory)).toBeCloseTo(s.totals.total, 2);
    expect(sum(s.byPeriod)).toBeCloseTo(s.totals.total, 2);
    expect(sum(s.bySource)).toBeCloseTo(s.totals.total, 2);
  });

  it("granularity=year raggruppa per anno", async () => {
    const s = await getStats(a, "?granularity=year");
    expect(s.byPeriod).toEqual([
      { period: "2025", total: 7, nReceipts: 1 },
      { period: "2026", total: 36.8, nReceipts: 3 },
    ]);
  });

  it("filtra per intervallo nel fuso Europe/Rome (to con la sola data è incluso)", async () => {
    const oct = await getStats(a, "?from=2026-10-01&to=2026-10-31");
    expect(oct.totals).toMatchObject({ total: 24.5, nReceipts: 2 });
    expect(oct.from).toBe("2026-09-30T22:00:00.000Z");
    expect(oct.to).toBe("2026-10-31T23:00:00.000Z");
    const sep = await getStats(a, "?to=2026-09-30");
    expect(sep.totals).toMatchObject({ total: 19.3, nReceipts: 2 });
  });

  it("intervallo vuoto o invertito", async () => {
    const empty = await getStats(a, "?from=2030-01-01");
    expect(empty.totals).toEqual({ total: 0, nReceipts: 0, average: 0 });
    expect(empty.byCategory).toEqual([]);
    const res = await h.call(a, "GET", "/v1/stats?from=2026-10-02&to=2026-10-01");
    expect(res.status).toBe(400);
    expect((await h.call(a, "GET", "/v1/stats?granularity=week")).status).toBe(400);
  });

  it("ogni utente vede solo i propri dati", async () => {
    const s = await getStats(b);
    expect(s.totals).toMatchObject({ total: 50, nReceipts: 1 });
    expect(s.topMerchants.map((m) => m.merchantName)).toEqual(["Negozio di B"]);
  });

  it("richiede l'autenticazione", async () => {
    expect((await h.app.request("/v1/stats")).status).toBe(401);
  });
});

interface Dataset {
  from: string | null;
  to: string | null;
  truncated: boolean;
  receipts: {
    id: string;
    date: string;
    merchantName: string | null;
    total: number | null;
    category: string;
    source: string;
  }[];
  items: { receiptId: string; description: string; amount: number | null; category: string }[];
}

const getDataset = async (userId: string, query = "") => {
  const res = await h.call(userId, "GET", `/v1/stats/dataset${query}`);
  expect(res.status).toBe(200);
  return json<Dataset>(res);
};

describe("GET /v1/stats/dataset", () => {
  it("restituisce scontrini e righe delle estrazioni correnti, dal più recente", async () => {
    const d = await getDataset(a);
    expect(d.truncated).toBe(false);
    // Esclusi lo scontrino fallito e l'estrazione non corrente ("Vecchia lettura").
    expect(d.receipts.map((r) => r.merchantName)).toEqual([
      "Bar Sport",
      "Supermercato",
      "Supermercato",
      null,
    ]);
    expect(d.receipts.map((r) => r.date)).toEqual(
      [...d.receipts.map((r) => r.date)].sort().reverse(),
    );
    const sum = d.receipts.reduce((acc, r) => acc + (r.total ?? 0), 0);
    expect(sum).toBeCloseTo((await getStats(a)).totals.total, 2);
    // Senza categoria né nello scontrino né nella riga: "altro".
    expect(d.receipts.at(-1)).toMatchObject({ category: "altro", source: "file", total: 7 });
    expect(d.items).toHaveLength(3);
    expect(d.items.map((i) => i.category)).toEqual(["alimentari", "alimentari", "altro"]);
    const ids = new Set(d.receipts.map((r) => r.id));
    expect(d.items.every((i) => ids.has(i.receiptId))).toBe(true);
  });

  it("filtra per intervallo come /v1/stats", async () => {
    const d = await getDataset(a, "?from=2026-10-01&to=2026-10-31");
    expect(d.from).toBe("2026-09-30T22:00:00.000Z");
    expect(d.to).toBe("2026-10-31T23:00:00.000Z");
    expect(d.receipts.map((r) => r.id)).toContain(lateSeptemberId);
    expect(d.receipts).toHaveLength(2);
    expect(d.items).toEqual([
      expect.objectContaining({ receiptId: lateSeptemberId, description: "Pane", amount: 12.3 }),
    ]);
    const res = await h.call(a, "GET", "/v1/stats/dataset?from=2026-10-02&to=2026-10-01");
    expect(res.status).toBe(400);
  });

  it("ogni utente vede solo i propri dati e serve l'autenticazione", async () => {
    const d = await getDataset(b);
    expect(d.receipts.map((r) => r.merchantName)).toEqual(["Negozio di B"]);
    expect(d.items).toHaveLength(1);
    expect((await h.app.request("/v1/stats/dataset")).status).toBe(401);
  });
});

describe("recompute-stats", () => {
  it("il job riscrive stats_monthly con i totali delle estrazioni correnti", async () => {
    const job = recomputeStatsJob(h.container.stats);
    expect(await job({ userId: a })).toEqual({ status: "recomputed", rows: 4 });
    const rows = await monthly(a);
    expect(rows).toEqual([
      { month: "2025-12-01", category: "altro", total: "7.00", n_receipts: 1 },
      { month: "2026-09-01", category: "alimentari", total: "12.30", n_receipts: 1 },
      { month: "2026-10-01", category: "alimentari", total: "20.00", n_receipts: 1 },
      { month: "2026-10-01", category: "ristorazione", total: "4.50", n_receipts: 1 },
    ]);
    const sum = rows.reduce((acc, r) => acc + Number(r.total), 0);
    expect(sum).toBeCloseTo((await sqlTotal(a)).total, 2);
    expect(await monthly(b)).toEqual([]);
  });

  it("dopo una cancellazione il ricalcolo rimuove le righe superate", async () => {
    const job = recomputeStatsJob(h.container.stats);
    const res = await h.call(a, "DELETE", `/v1/receipts/${lateSeptemberId}`);
    expect(res.status).toBe(204);
    expect(h.queue.events.at(-1)).toEqual({ name: "stats/recompute", data: { userId: a } });
    await job({ userId: a });
    const rows = await monthly(a);
    expect(rows.map((r) => `${r.month}/${r.category}`)).toEqual([
      "2025-12-01/altro",
      "2026-09-01/alimentari",
      "2026-10-01/ristorazione",
    ]);
    expect((await getStats(a)).totals.total).toBe(23.8);
  });

  it("ignora un evento non valido", async () => {
    const job = recomputeStatsJob(h.container.stats);
    expect(await job({ userId: "non-un-uuid" })).toEqual({ status: "skipped" });
    expect(await job(null)).toEqual({ status: "skipped" });
  });

  it("ricalcoli concorrenti dello stesso utente non vanno in conflitto", async () => {
    await Promise.all([h.container.stats.recompute(a), h.container.stats.recompute(a)]);
    expect(await monthly(a)).toHaveLength(3);
  });
});

describe("GET /cron/recompute-stats", () => {
  const cron = (auth?: string) =>
    h.app.request("/cron/recompute-stats", auth ? { headers: { Authorization: auth } } : {});

  it("rifiuta richieste senza segreto o con un segreto sbagliato", async () => {
    for (const auth of [undefined, "Bearer sbagliato", "test-cron-secret-0123456789"]) {
      const res = await cron(auth);
      expect(res.status).toBe(401);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("UNAUTHORIZED");
    }
  });

  it("non accetta un access token utente al posto del segreto", async () => {
    const res = await cron(`Bearer ${await h.auth.token(a)}`);
    expect(res.status).toBe(401);
  });

  it("con il segreto giusto ricalcola tutti gli utenti", async () => {
    await h.t.query(`delete from stats_monthly`);
    const res = await cron(`Bearer ${h.env.CRON_SECRET ?? ""}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, users: 2, failed: 0 });
    expect(await monthly(a)).toHaveLength(3);
    expect(await monthly(b)).toEqual([
      { month: "2026-09-01", category: "alimentari", total: "50.00", n_receipts: 1 },
    ]);
  });

  it("senza CRON_SECRET risponde 503", async () => {
    const other = await createTestApp({ CRON_SECRET: "" });
    try {
      const res = await other.app.request("/cron/recompute-stats", {
        headers: { Authorization: "Bearer qualunque-segreto-lungo" },
      });
      expect(res.status).toBe(503);
    } finally {
      await other.close();
    }
  });
});

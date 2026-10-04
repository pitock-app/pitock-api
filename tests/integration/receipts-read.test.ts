import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { seedExtractedFile } from "../helpers/seed.js";

let h: TestApp;
let user: string;

beforeAll(async () => {
  h = await createTestApp();
  user = await h.t.createUser();
});
afterAll(() => h.close());
beforeEach(() => {
  h.queue.clear();
});

interface ListBody {
  items: { id: string; merchantName: string | null; category: string | null; total: number }[];
  nextCursor: string | null;
}

describe("GET /v1/receipts", () => {
  let ids: string[];

  beforeAll(async () => {
    const u = await h.t.createUser();
    ids = [];
    for (let i = 0; i < 5; i++) {
      const { receipt } = await seedExtractedFile(h.t.db, u, {
        merchantName: i % 2 ? "Farmacia 100%" : "Esselunga",
        category: i % 2 ? "salute" : "alimentari",
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)),
      });
      ids.unshift(receipt.id);
    }
    user = u;
  });

  it("pagina con cursori, dal più recente", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : "";
      const page: ListBody = await json<ListBody>(
        await h.call(user, "GET", `/v1/receipts?limit=2${qs}`),
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
  });

  it("filtra per categoria, testo (con caratteri LIKE) e stato", async () => {
    const byCat = await json<ListBody>(await h.call(user, "GET", "/v1/receipts?category=salute"));
    expect(byCat.items).toHaveLength(2);
    const byQ = await json<ListBody>(await h.call(user, "GET", "/v1/receipts?q=100%25"));
    expect(byQ.items.every((i) => i.merchantName === "Farmacia 100%")).toBe(true);
    expect(byQ.items).toHaveLength(2);
    const byStatus = await json<ListBody>(await h.call(user, "GET", "/v1/receipts?status=failed"));
    expect(byStatus.items).toEqual([]);
  });

  it("filtra per data d'acquisto (to con la sola data comprende il giorno)", async () => {
    const inRange = await json<ListBody>(
      await h.call(user, "GET", "/v1/receipts?from=2026-09-20&to=2026-09-20"),
    );
    expect(inRange.items).toHaveLength(5);
    const out = await json<ListBody>(await h.call(user, "GET", "/v1/receipts?from=2026-09-21"));
    expect(out.items).toEqual([]);
  });

  it("limit oltre 100 o cursore non valido → 400", async () => {
    expect((await h.call(user, "GET", "/v1/receipts?limit=101")).status).toBe(400);
    expect((await h.call(user, "GET", "/v1/receipts?cursor=abc")).status).toBe(400);
  });
});

describe("dettaglio, storico, modifica, rielaborazione, cancellazione", () => {
  it("il dettaglio include estrazione corrente, righe, usage e fileUrl", async () => {
    const { receipt } = await seedExtractedFile(h.t.db, user);
    const d = await json(await h.call(user, "GET", `/v1/receipts/${receipt.id}`));
    expect(d.fileUrl).toBeTypeOf("string");
    expect(d.usage).toEqual({
      provider: "anthropic",
      model: "fake-model",
      totalTokens: 150,
      costUsd: null,
    });
    expect(d.items).toHaveLength(1);
    expect(d.extraction).toMatchObject({ method: "llm", merchantName: "Supermercato" });
  });

  it("PATCH aggiorna i campi, sostituisce le righe e marca edited_by_user", async () => {
    const { receipt, extraction } = await seedExtractedFile(h.t.db, user);
    const res = await h.call(user, "PATCH", `/v1/extractions/${extraction.id}`, {
      merchantName: "Coop",
      total: 20,
      purchasedAt: null,
      items: [
        { description: "Latte", amount: 1.5 },
        { description: "Uova", amount: 18.5 },
      ],
    });
    expect(res.status).toBe(200);
    const e = await json<{ merchantName: string; editedByUser: boolean; items: unknown[] }>(res);
    expect(e).toMatchObject({ merchantName: "Coop", editedByUser: true, purchasedAt: null });
    expect(e.items).toHaveLength(2);
    expect(h.queue.events).toEqual([{ name: "stats/recompute", data: { userId: user } }]);

    const d = await json<{ items: unknown[] }>(
      await h.call(user, "GET", `/v1/receipts/${receipt.id}`),
    );
    expect(d.items).toHaveLength(2);
  });

  it("PATCH con corpo vuoto → 400", async () => {
    const { extraction } = await seedExtractedFile(h.t.db, user);
    const res = await h.call(user, "PATCH", `/v1/extractions/${extraction.id}`, {});
    expect(res.status).toBe(400);
  });

  it("reextract rimette in coda con l'override del modello", async () => {
    const { receipt } = await seedExtractedFile(h.t.db, user);
    const res = await h.call(user, "POST", `/v1/receipts/${receipt.id}/reextract`, {
      provider: "openai",
      model: "altro-modello",
    });
    expect(res.status).toBe(202);
    expect(h.queue.events).toEqual([
      {
        name: "receipt/uploaded",
        data: {
          receiptId: receipt.id,
          userId: user,
          reextract: { provider: "openai", model: "altro-modello" },
        },
      },
    ]);
    // Già in coda: un secondo reextract è rifiutato.
    const again = await h.call(user, "POST", `/v1/receipts/${receipt.id}/reextract`);
    expect(again.status).toBe(409);
  });

  it("reextract di uno scontrino manuale → 409", async () => {
    const res = await h.call(user, "POST", "/v1/receipts/manual", {
      merchantName: "Edicola",
      purchasedAt: "2026-10-01",
      total: 2,
      paymentMethod: "contanti",
      category: "svago",
    });
    const d = await json<{ receipt: { id: string } }>(res);
    const r = await h.call(user, "POST", `/v1/receipts/${d.receipt.id}/reextract`, {});
    expect(r.status).toBe(409);
  });

  it("lo storico mostra tutte le estrazioni, la corrente in evidenza", async () => {
    const { receipt } = await seedExtractedFile(h.t.db, user);
    await h.t.exec(
      `update extractions set is_current = false where receipt_id = '${receipt.id}';
       insert into extractions (receipt_id, user_id, method, raw_json, merchant_name)
       values ('${receipt.id}', '${user}', 'llm', '{}', 'Nuova');`,
    );
    const body = await json<{ items: { merchantName: string; isCurrent: boolean }[] }>(
      await h.call(user, "GET", `/v1/receipts/${receipt.id}/extractions`),
    );
    expect(body.items.map((i) => [i.merchantName, i.isCurrent])).toEqual([
      ["Nuova", true],
      ["Supermercato", false],
    ]);
    // L'estrazione vecchia non si modifica.
    const [old] = await h.t.query<{ id: string }>(
      `select id from extractions where receipt_id = '${receipt.id}' and not is_current`,
    );
    const p = await h.call(user, "PATCH", `/v1/extractions/${old?.id ?? ""}`, { total: 1 });
    expect(p.status).toBe(409);
  });

  it("DELETE cancella file, estrazioni e righe; llm_usage resta con receipt_id null", async () => {
    const { receipt } = await seedExtractedFile(h.t.db, user);
    const path = receipt.storagePath ?? "";
    h.storage.put(path, new Uint8Array([1]), "image/jpeg");
    const res = await h.call(user, "DELETE", `/v1/receipts/${receipt.id}`);
    expect(res.status).toBe(204);
    expect(h.storage.objects.has(path)).toBe(false);
    expect((await h.call(user, "GET", `/v1/receipts/${receipt.id}`)).status).toBe(404);
    const ex = await h.t.query(`select 1 from extractions where receipt_id = '${receipt.id}'`);
    expect(ex).toEqual([]);
    expect(h.queue.events).toEqual([{ name: "stats/recompute", data: { userId: user } }]);
  });
});

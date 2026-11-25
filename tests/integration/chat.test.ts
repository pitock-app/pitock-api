import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { receiptItems } from "../../src/infra/db/schema/index.js";
import { UNVERIFIED_ANSWER } from "../../src/modules/chat/chat.service.js";
import type { LlmChatRequest } from "../../src/ports/llm.port.js";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { seedExtractedFile } from "../helpers/seed.js";

interface ChatRes {
  answer: string;
  grounded: boolean;
  charts: { type: string; title: string; points: { label: string; value: number }[] }[];
}

let h: TestApp;
let a: string;
let b: string;

const NOVEMBER = { from: "2026-11-01", to: "2026-11-25" };

/** Scontrino di novembre con le righe date (sostituiscono la riga "Pane" del seed). */
const seedItems = async (userId: string, items: [string, number][]) => {
  const { extraction } = await seedExtractedFile(h.t.db, userId, {
    purchasedAt: new Date("2026-11-10T10:00:00Z"),
    total: items.reduce((s, [, amount]) => s + amount, 0),
  });
  await h.t.exec(`delete from receipt_items where extraction_id = '${extraction.id}'`);
  await h.t.db.insert(receiptItems).values(
    items.map(([name, amount], position) => ({
      extractionId: extraction.id,
      userId,
      position,
      description: name.toUpperCase(),
      normalizedName: name,
      amount,
    })),
  );
};

const ask = async (userId: string, content: string) => {
  const res = await h.call(userId, "POST", "/v1/chat", { messages: [{ role: "user", content }] });
  expect(res.status).toBe(200);
  return json<ChatRes>(res);
};

const tool = (req: LlmChatRequest, name: string, input: unknown) => {
  const t = req.tools[name];
  if (!t) throw new Error(`strumento ${name} assente`);
  return t.execute(input) as Promise<Record<string, unknown>>;
};

type Row = { label: string; total: number };

beforeAll(async () => {
  h = await createTestApp();
  a = await h.t.createUser();
  b = await h.t.createUser();
  await seedItems(a, [
    ["Petto di pollo", 6.5],
    ["Macinato bovino", 4.2],
    ["Latte intero", 1.3],
  ]);
  await seedItems(b, [["Salsiccia", 99]]);
});
beforeEach(() => {
  h.llm.reset();
});
afterAll(() => h.close());

describe("POST /v1/chat", () => {
  it("risponde con il totale della carne calcolato dagli strumenti, solo sui dati dell'utente", async () => {
    let seen: unknown;
    h.llm.respondChat(async (req) => {
      seen = await tool(req, "list_products", NOVEMBER);
      const res = await tool(req, "spending", {
        ...NOVEMBER,
        groupBy: "none",
        products: ["petto di pollo", "Macinato bovino"],
        chart: "none",
      });
      const total = (res.rows as Row[])[0]?.total ?? 0;
      return `Questo mese hai speso ${total.toFixed(2).replace(".", ",")} € di carne.`;
    });

    const res = await ask(a, "Quanto ho speso di carne questo mese?");

    expect(res).toEqual({
      answer: "Questo mese hai speso 10,70 € di carne.",
      grounded: true,
      charts: [],
    });
    const names = (seen as { products: { name: string }[] }).products.map((p) => p.name);
    expect(names.sort()).toEqual(["Latte intero", "Macinato bovino", "Petto di pollo"]);
    expect(h.llm.chats[0]?.instructions).toContain("2026-10-04");
    const usage = await h.t.query<{ operation: string; success: boolean }>(
      `select operation, success from llm_usage where user_id = '${a}' and operation = 'chat'`,
    );
    expect(usage).toEqual([{ operation: "chat", success: true }]);
  });

  it("restituisce il grafico quando l'assistente lo chiede su più gruppi, non su un totale", async () => {
    h.llm.respondChat(async (req) => {
      await tool(req, "spending", {
        ...NOVEMBER,
        groupBy: "product",
        chart: "bar",
        chartTitle: "Spesa per prodotto",
      });
      await tool(req, "spending", { ...NOVEMBER, groupBy: "none", chart: "pie" });
      return "Ecco la spesa per prodotto.";
    });

    const res = await ask(a, "Mostrami la spesa per prodotto");

    expect(res.grounded).toBe(true);
    expect(res.charts).toEqual([
      {
        type: "bar",
        title: "Spesa per prodotto",
        points: [
          { label: "Petto di pollo", value: 6.5 },
          { label: "Macinato bovino", value: 4.2 },
          { label: "Latte intero", value: 1.3 },
        ],
      },
    ]);
  });

  it("rigenera una volta se c'è un numero inventato, poi risponde con il ripiego", async () => {
    h.llm.respondChat(
      () => Promise.resolve("Hai speso 999 €."),
      () => Promise.resolve("Hai speso 123,45 €."),
    );

    const res = await ask(a, "Quanto ho speso?");

    expect(res).toEqual({ answer: UNVERIFIED_ANSWER, grounded: false, charts: [] });
    expect(h.llm.chats).toHaveLength(2);
    expect(h.llm.chats[1]?.messages.at(-1)?.content).toContain("999");
  });

  it("accetta la risposta rigenerata se i numeri tornano", async () => {
    h.llm.respondChat(
      () => Promise.resolve("Hai speso 999 €."),
      async (req) => {
        const res = await tool(req, "spending", { ...NOVEMBER, groupBy: "none", chart: "none" });
        return `Hai speso ${(res.rows as Row[])[0]?.total} €.`;
      },
    );

    const res = await ask(a, "Quanto ho speso?");

    expect(res).toEqual({ answer: "Hai speso 12 €.", grounded: true, charts: [] });
  });

  it("gli strumenti rifiutano argomenti e periodi non validi senza interrompere la chat", async () => {
    let outputs: unknown[] = [];
    h.llm.respondChat(async (req) => {
      outputs = [
        await tool(req, "spending", {
          from: "2026-11-25",
          to: "2026-11-01",
          groupBy: "none",
          chart: "none",
        }),
        await tool(req, "spending", { ...NOVEMBER, groupBy: "user", chart: "none" }),
      ];
      return "Non ho dati.";
    });

    const res = await ask(a, "Quanto ho speso?");

    expect(res.grounded).toBe(true);
    expect((outputs[0] as { error: string }).error).toContain("Periodo non valido");
    expect(outputs[1]).toEqual({ error: "Argomenti non validi", issues: ["groupBy"] });
  });

  it("l'errore del provider diventa 502 ed è registrato in llm_usage", async () => {
    const { LlmError } = await import("../../src/ports/llm.port.js");
    h.llm.respondChat(new LlmError("unavailable", "giù"));

    const res = await h.call(b, "POST", "/v1/chat", {
      messages: [{ role: "user", content: "Quanto ho speso?" }],
    });

    expect(res.status).toBe(502);
    const usage = await h.t.query<{ success: boolean; error_code: string }>(
      `select success, error_code from llm_usage where user_id = '${b}' and operation = 'chat'`,
    );
    expect(usage).toEqual([{ success: false, error_code: "unavailable" }]);
  });

  it("400 se l'ultimo messaggio non è dell'utente", async () => {
    const res = await h.call(a, "POST", "/v1/chat", {
      messages: [{ role: "assistant", content: "Ciao" }],
    });
    expect(res.status).toBe(400);
  });
});

import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { modelPrices } from "../../src/infra/db/schema/index.js";
import { extractReceiptJob } from "../../src/jobs/extract-receipt.job.js";
import { LlmError } from "../../src/ports/llm.port.js";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { detail, runJobs, uploaded, usageRows } from "../helpers/extraction.js";
import { usage, validOutput } from "../helpers/fakes.js";

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(() => h.close());
beforeEach(() => {
  h.queue.clear();
  h.llm.reset();
});

describe("extract-receipt: successo", () => {
  it("estrae con la chiave della piattaforma e salva estrazione, righe e llm_usage", async () => {
    const user = await h.t.createUser();
    const { receiptId, bytes } = await uploaded(h, user);
    h.llm.respond({ output: validOutput(), usage: usage() });

    const [outcome] = await runJobs(h);
    expect(outcome?.status).toBe("extracted");

    const req = h.llm.requests[0];
    expect(req).toMatchObject({
      provider: "anthropic",
      model: "fake-model",
      apiKey: "test-platform-key",
      files: [{ mimeType: "image/jpeg" }],
    });
    expect(req?.files[0]?.bytes).toEqual(bytes);

    const d = await detail(h, user, receiptId);
    expect(d.receipt).toMatchObject({ status: "extracted", errorCode: null });
    expect(d.extraction).toMatchObject({
      merchantName: "Supermercato Rossi",
      total: 12.3,
      confidence: 0.92,
      provider: "anthropic",
      model: "fake-model",
      keySource: "platform",
      promptVersion: "v4",
      purchasedAt: "2026-10-03T16:30:00.000Z",
    });
    expect(d.items.map((i) => i.description)).toEqual(["Pane", "Vino"]);
    expect(d.usage).toMatchObject({
      provider: "anthropic",
      model: "fake-model",
      totalTokens: 1200,
    });

    const rows = await usageRows(h, receiptId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: "extract",
      key_source: "platform",
      success: true,
      extraction_id: d.extraction?.id,
      cost_usd: null,
    });
    expect(h.queue.events).toEqual([{ name: "stats/recompute", data: { userId: user } }]);

    // `/v1/me` conta l'estrazione nella quota della piattaforma.
    const me = await json<{ platformQuota: { used: number } }>(await h.call(user, "GET", "/v1/me"));
    expect(me.platformQuota.used).toBe(1);
  });

  it("calcola cost_usd quando il modello è in model_prices", async () => {
    await h.t.db.insert(modelPrices).values({
      provider: "anthropic",
      model: "fake-model",
      inputPerMtokUsd: 3,
      outputPerMtokUsd: 15,
    });
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user);
    h.llm.respond({ output: validOutput(), usage: usage(1000, 200) });
    await runJobs(h);
    expect((await usageRows(h, receiptId))[0]?.cost_usd).toBe("0.006000");
    expect((await detail(h, user, receiptId)).usage?.costUsd).toBe(0.006);
    await h.t.exec("delete from model_prices");
  });

  it("abbassa la confidenza se la somma delle righe non torna", async () => {
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user);
    h.llm.respond({ output: validOutput({ total: 20 }), usage: usage() });
    await runJobs(h);
    const d = await detail(h, user, receiptId);
    expect(d.extraction?.confidence).toBe(0.5);
    expect(d.extraction?.notes).toMatch(/somma delle righe/);
  });

  it("un evento ripetuto non rielabora lo scontrino", async () => {
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user);
    h.llm.respond({ output: validOutput(), usage: usage() });
    const job = extractReceiptJob(h.container.extraction);
    expect((await job({ receiptId, userId: user })).status).toBe("extracted");
    expect(await job({ receiptId, userId: user })).toMatchObject({ status: "skipped" });
    expect(h.llm.requests).toHaveLength(1);
  });

  it("ignora eventi non validi o di un altro utente", async () => {
    const a = await h.t.createUser();
    const b = await h.t.createUser();
    const { receiptId } = await uploaded(h, a);
    const job = extractReceiptJob(h.container.extraction);
    expect(await job({ receiptId, userId: b })).toMatchObject({ status: "skipped" });
    expect(await job({ receiptId: "x", userId: a })).toMatchObject({ status: "skipped" });
    expect(h.llm.requests).toHaveLength(0);
    expect((await detail(h, a, receiptId)).receipt.status).toBe("uploaded");
  });
});

describe("extract-receipt: output non valido", () => {
  it("riprova una volta e poi salva l'estrazione", async () => {
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user);
    h.llm.respond(
      { output: { is_receipt: "forse" }, usage: usage(900, 50) },
      { output: validOutput(), usage: usage() },
    );
    await runJobs(h);
    expect(h.llm.requests).toHaveLength(2);
    expect((await detail(h, user, receiptId)).receipt.status).toBe("extracted");
    const rows = await usageRows(h, receiptId);
    expect(rows.map((r) => [r.success, r.error_code])).toEqual([
      [false, "INVALID_OUTPUT"],
      [true, null],
    ]);
    expect(rows.find((r) => r.success)?.extraction_id).not.toBeNull();
    expect(rows.find((r) => !r.success)?.extraction_id).toBeNull();
  });

  it("dopo il retry fallito lo scontrino è failed con INVALID_OUTPUT", async () => {
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user);
    h.llm.respond(new LlmError("invalid_output", "x", usage(900, 50)), {
      output: { total: "dodici" },
      usage: usage(),
    });
    expect(await runJobs(h)).toEqual([{ status: "failed", errorCode: "INVALID_OUTPUT" }]);
    const d = await detail(h, user, receiptId);
    expect(d.receipt).toMatchObject({ status: "failed", errorCode: "INVALID_OUTPUT" });
    expect(d.extraction).toBeUndefined();
    expect(await usageRows(h, receiptId)).toHaveLength(2);
    expect(h.queue.events).toEqual([]);
  });

  it("is_receipt=false → failed con NOT_A_RECEIPT", async () => {
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user);
    h.llm.respond({ output: validOutput({ is_receipt: false }), usage: usage() });
    await runJobs(h);
    expect((await detail(h, user, receiptId)).receipt).toMatchObject({
      status: "failed",
      errorCode: "NOT_A_RECEIPT",
    });
    expect(await usageRows(h, receiptId)).toHaveLength(1);
  });
});

describe("extract-receipt: PDF", () => {
  it("passa il PDF al modello", async () => {
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user, "pdf");
    h.llm.respond({ output: validOutput(), usage: usage() });
    await runJobs(h);
    expect(h.llm.requests[0]?.files).toHaveLength(1);
    expect(h.llm.requests[0]?.files[0]?.mimeType).toBe("application/pdf");
    expect((await detail(h, user, receiptId)).receipt.status).toBe("extracted");
  });

  it("salva insegna e prodotti normalizzati e li conserva quando si corregge", async () => {
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user);
    h.llm.respond({
      output: validOutput({
        merchant_name: "LIDL ITALIA S.R.L.",
        merchant_brand: " Lidl ",
        items: [
          {
            description: "LATTE PS UHT 1L GRANAR",
            quantity: 1,
            unit_price: 1.5,
            amount: 1.5,
            vat_rate: 4,
            category: "alimentari",
            normalized_name: "Latte parzialmente scremato UHT",
            brand: "Granarolo",
            size: 1,
            size_unit: "l",
          },
          // Un modello che non restituisce i campi nuovi non fa fallire l'estrazione.
          {
            description: "Pane",
            quantity: 1,
            unit_price: 10.8,
            amount: 10.8,
            vat_rate: 4,
            category: null,
          },
        ],
      }),
      usage: usage(),
    });
    await runJobs(h);
    const d = await detail(h, user, receiptId);
    expect(d.extraction).toMatchObject({
      merchantName: "LIDL ITALIA S.R.L.",
      merchantBrand: "Lidl",
    });
    const items = (d.extraction as unknown as { id: string; items: Record<string, unknown>[] })
      .items;
    expect(items[0]).toMatchObject({
      normalizedName: "Latte parzialmente scremato UHT",
      brand: "Granarolo",
      size: 1,
      sizeUnit: "l",
    });
    expect(items[1]).toMatchObject({
      normalizedName: null,
      brand: null,
      size: null,
      sizeUnit: null,
    });

    const id = (d.extraction as unknown as { id: string }).id;
    const patch = await h.call(user, "PATCH", `/v1/extractions/${id}`, {
      merchantBrand: "Lidl",
      // Come il frontend: rimanda le righe senza id e posizione, senza i campi null.
      items: items.map((item) =>
        Object.fromEntries(
          Object.entries(item).filter(([k, v]) => v !== null && k !== "id" && k !== "position"),
        ),
      ),
    });
    expect(patch.status).toBe(200);
    const updated = await json<{ merchantBrand: string; items: Record<string, unknown>[] }>(patch);
    expect(updated.merchantBrand).toBe("Lidl");
    expect(updated.items[0]).toMatchObject({
      normalizedName: "Latte parzialmente scremato UHT",
      size: 1,
    });
  });

  it("uno scontrino lungo arriva al modello in fasce, in una sola chiamata", async () => {
    const user = await h.t.createUser();
    const tall = await sharp({
      create: { width: 800, height: 6000, channels: 3, background: "#ffffff" },
    })
      .jpeg()
      .toBuffer();
    const { receiptId } = await uploaded(h, user, "jpeg", new Uint8Array(tall));
    h.llm.respond({ output: validOutput(), usage: usage() });
    await runJobs(h);
    const [req] = h.llm.requests;
    if (!req) throw new Error("nessuna richiesta al modello");
    expect(req.files.length).toBeGreaterThan(1);
    expect(req.files.every((f) => f.mimeType === "image/jpeg")).toBe(true);
    expect(req.prompt).toContain(`diviso in ${req.files.length} immagini consecutive`);
    expect(h.llm.requests).toHaveLength(1);
    expect((await detail(h, user, receiptId)).receipt.status).toBe("extracted");
  });

  it("PDF non supportato dal modello → failed con UNSUPPORTED_FILE_TYPE, senza retry", async () => {
    const user = await h.t.createUser();
    const { receiptId } = await uploaded(h, user, "pdf");
    h.llm.respond(new LlmError("unsupported_file", "pdf"));
    await runJobs(h);
    expect(h.llm.requests).toHaveLength(1);
    expect((await detail(h, user, receiptId)).receipt).toMatchObject({
      status: "failed",
      errorCode: "UNSUPPORTED_FILE_TYPE",
    });
    expect((await usageRows(h, receiptId))[0]).toMatchObject({
      success: false,
      error_code: "UNSUPPORTED_FILE_TYPE",
    });
  });
});

describe("/api/inngest", () => {
  it("è montato fuori da /v1 e rifiuta le richieste senza firma Inngest", async () => {
    for (const method of ["GET", "POST"]) {
      const res = await h.app.request("/api/inngest", {
        method,
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(res.status).toBe(401);
      // La risposta è dell'handler Inngest, non del middleware auth di /v1.
      const body = await json<{ error?: unknown }>(res);
      expect(body.error).toBeUndefined();
    }
    expect(h.llm.requests).toHaveLength(0);
  });

  it("senza signing key e senza INNGEST_DEV=1 risponde 503", async () => {
    const q = await createTestApp({ INNGEST_SIGNING_KEY: "", INNGEST_DEV: "0" });
    try {
      const res = await q.app.request("/api/inngest", { method: "POST", body: "{}" });
      expect(res.status).toBe(503);
      expect(await json<{ error: { code: string } }>(res)).toMatchObject({
        error: { code: "SERVICE_UNAVAILABLE" },
      });
    } finally {
      await q.close();
    }
  });
});

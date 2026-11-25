import { APICallError, UnsupportedFunctionalityError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inngestDevMode, inngestServable } from "../../src/infra/queue/inngest.client.js";
import { classifyLlmError, createAiSdkLlm } from "../../src/infra/llm/ai-sdk.adapter.js";
import { ReceiptExtraction } from "../../src/modules/extraction/extraction.schema.js";
import {
  LLM_BUDGET_MARGIN_MS,
  LLM_BUDGET_MS,
  llmBudgetMs,
} from "../../src/modules/extraction/extraction.service.js";
import {
  EUR_RATES,
  isBreakdownLine,
  postprocess,
} from "../../src/modules/extraction/postprocess.js";
import { costUsd } from "../../src/modules/usage/pricing.js";
import { LlmError } from "../../src/ports/llm.port.js";
import { JPEG, PDF, validOutput } from "../helpers/fakes.js";
import { testEnv } from "../helpers/test-env.js";

const parse = (o: Record<string, unknown> = {}) => ReceiptExtraction.parse(validOutput(o));

describe("postprocess", () => {
  it("converte in euro gli importi in USD con un cambio indicativo", () => {
    const r = postprocess(parse({ currency: "usd" }));
    const base = postprocess(parse());
    const usd = EUR_RATES.USD ?? NaN;
    expect(r.fields.currency).toBe("EUR");
    expect(r.fields.total).toBe(Number(((base.fields.total ?? 0) * usd).toFixed(2)));
    expect(r.items[0]?.amount).toBe(Number(((base.items[0]?.amount ?? 0) * usd).toFixed(2)));
    expect(r.fields.notes).toContain("USD");
    expect(postprocess(parse({ currency: "JPY" })).fields.currency).toBe("JPY");
  });

  it("mantiene la confidenza se la somma delle righe coincide con il totale", () => {
    const r = postprocess(parse());
    expect(r.isReceipt).toBe(true);
    expect(r.confidence).toBe(0.92);
    expect(r.fields.notes).toBeNull();
    expect(r.items).toHaveLength(2);
  });

  it("riporta l'evitabilità di scontrino e righe; se manca è null", () => {
    const r = postprocess(parse());
    expect(r.fields.avoidability).toBe("utile");
    expect(r.items.map((i) => i.avoidability)).toEqual(["essenziale", "superfluo"]);
    const old = postprocess(
      parse({
        avoidability: undefined,
        items: [
          {
            description: "x",
            quantity: 1,
            unit_price: 1,
            amount: 1,
            vat_rate: null,
            category: null,
          },
        ],
        total: 1,
      }),
    );
    expect(old.fields.avoidability).toBeNull();
    expect(old.items[0]?.avoidability).toBeNull();
  });

  it("tollera uno scarto fino a 0,05", () => {
    expect(postprocess(parse({ total: 12.35 })).confidence).toBe(0.92);
  });

  it("oltre 0,05 porta la confidenza al massimo a 0,5 e aggiunge una nota", () => {
    const r = postprocess(parse({ total: 15, notes: "scontrino sbiadito" }));
    expect(r.confidence).toBe(0.5);
    expect(r.fields.notes).toContain("scontrino sbiadito");
    expect(r.fields.notes).toContain("12.30");
    expect(postprocess(parse({ total: 15, confidence: 0.3 })).confidence).toBe(0.3);
  });

  it("senza importi nelle righe non confronta", () => {
    const r = postprocess(
      parse({
        items: [
          {
            description: "x",
            quantity: null,
            unit_price: null,
            amount: null,
            vat_rate: null,
            category: null,
          },
        ],
      }),
    );
    expect(r.confidence).toBe(0.92);
  });

  it("interpreta le date senza fuso in Europe/Rome e scarta quelle illeggibili", () => {
    expect(postprocess(parse()).fields.purchasedAt?.toISOString()).toBe("2026-10-03T16:30:00.000Z");
    expect(postprocess(parse({ purchased_at: "03/10/2026" })).fields.purchasedAt).toBeNull();
  });

  it("scarta le righe di scorporo (IVA, sconti) e tiene il totale finale", () => {
    const line = (description: string, amount: number) => ({
      description,
      quantity: null,
      unit_price: null,
      amount,
      vat_rate: null,
      category: null,
    });
    const r = postprocess(
      parse({
        total: 21.96,
        tax_total: 3.96,
        items: [
          line("Abbonamento", 18),
          line("VAT - Italy (22% on €18.00)", 3.96),
          line("Sconto", -1),
        ],
      }),
    );
    expect(r.fields.total).toBe(21.96);
    expect(r.items.map((i) => i.description)).toEqual(["Abbonamento"]);
    // Righe al netto IVA + tax_total = totale: nessuna penalità.
    expect(r.confidence).toBe(0.92);
  });

  it("porta a IVA inclusa le righe di una fattura al netto: si salva il prezzo pagato", () => {
    const line = (description: string, quantity: number, unit_price: number, amount: number) => ({
      description,
      quantity,
      unit_price,
      amount,
      vat_rate: 22,
      category: null,
    });
    const r = postprocess(
      parse({
        total: 305,
        tax_total: 55,
        items: [line("Rifacimento tetto auto", 1, 200, 200), line("Materiali", 2, 25, 50)],
      }),
    );
    expect(r.items.map((i) => [i.amount, i.unitPrice])).toEqual([
      [244, 244],
      [61, 30.5],
    ]);
    expect(r.items.reduce((sum, i) => sum + (i.amount ?? 0), 0)).toBe(305);
    expect(r.fields.total).toBe(305);
    expect(r.confidence).toBe(0.92);
  });

  it("non tocca le righe che tornano già col totale, anche con tax_total", () => {
    const r = postprocess(parse({ tax_total: 2.22 }));
    expect(r.items.map((i) => i.amount)).toEqual(postprocess(parse()).items.map((i) => i.amount));
  });

  it("riconosce le righe di scorporo senza toccare i prodotti", () => {
    for (const d of ["IVA", "I.V.A. 22%", "Accise e IVA", "SCONTO 20%", "Subtotale", "VAT - Italy"])
      expect(isBreakdownLine(d), d).toBe(true);
    for (const d of ["Libero IVA 4%", "Pane", "Ivanhoe libro", "Totalizzatore", "Bollo"])
      expect(isBreakdownLine(d), d).toBe(false);
  });

  it("riporta is_receipt=false", () => {
    expect(postprocess(parse({ is_receipt: false })).isReceipt).toBe(false);
  });
});

describe("pricing", () => {
  it("calcola il costo per milione di token", () => {
    expect(costUsd({ inputPerMtokUsd: 3, outputPerMtokUsd: 15 }, 1000, 200)).toBe(0.006);
  });

  it("restituisce null se manca il prezzo o il conteggio", () => {
    expect(costUsd(undefined, 1000, 200)).toBeNull();
    expect(costUsd({ inputPerMtokUsd: 3, outputPerMtokUsd: 15 }, null, 200)).toBeNull();
  });
});

const apiError = (statusCode: number, responseBody = "") =>
  new APICallError({
    message: "boom sk-ant-secret",
    url: "https://api.test",
    requestBodyValues: { apiKey: "sk-ant-secret" },
    statusCode,
    responseBody,
  });

it("lo schema resta entro il limite Anthropic di 16 campi con unioni", () => {
  const json = JSON.stringify(z.toJSONSchema(ReceiptExtraction));
  const unions = (json.match(/"anyOf"|"type":\[/g) ?? []).length;
  expect(unions).toBeLessThanOrEqual(16);
});

describe("classifyLlmError", () => {
  it.each([
    [401, "", "auth"],
    [403, "", "auth"],
    [402, "", "quota"],
    [429, "", "quota"],
    [400, '{"error":"PDF not supported"}', "unsupported_file"],
    [400, '{"error":{"message":"Your credit balance is too low"}}', "quota"],
    [400, '{"error":"bad request"}', "unavailable"],
    [500, "", "unavailable"],
  ])("HTTP %i %s → %s", (status, body, kind) => {
    const e = classifyLlmError(apiError(status, body));
    expect(e.kind).toBe(kind);
    expect(e.message).not.toContain("sk-ant");
  });

  it("riconosce le funzionalità non supportate e gli errori sconosciuti", () => {
    expect(classifyLlmError(new UnsupportedFunctionalityError({ functionality: "pdf" })).kind).toBe(
      "unsupported_file",
    );
    expect(classifyLlmError(new Error("x")).kind).toBe("unavailable");
  });
});

const mockModel = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1200, noCache: 1200, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 300, text: 300, reasoning: undefined },
      },
      warnings: [],
    },
  });

const request = (mimeType: "image/jpeg" | "application/pdf", bytes: Uint8Array) => ({
  provider: "anthropic" as const,
  model: "fake-model",
  apiKey: "sk-ant-test-key-0000",
  instructions: "istruzioni",
  prompt: "estrai",
  files: [{ bytes, mimeType }],
  schema: ReceiptExtraction,
});

describe("adapter AI SDK", () => {
  it("restituisce l'output strutturato e i token usati", async () => {
    const model = mockModel(JSON.stringify(validOutput()));
    const llm = createAiSdkLlm(() => model);
    const res = await llm.generateStructured(request("image/jpeg", JPEG()));
    expect(res.output).toEqual(validOutput());
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 300, totalTokens: 1500 });

    const call = model.doGenerateCalls[0];
    const user = call?.prompt.find((m) => m.role === "user");
    const parts = user && Array.isArray(user.content) ? user.content : [];
    expect(parts.some((p) => p.type === "file" && p.mediaType.startsWith("image/"))).toBe(true);
  });

  it("passa i PDF come file part application/pdf", async () => {
    const model = mockModel(JSON.stringify(validOutput()));
    await createAiSdkLlm(() => model).generateStructured(request("application/pdf", PDF()));
    const user = model.doGenerateCalls[0]?.prompt.find((m) => m.role === "user");
    const parts = user && Array.isArray(user.content) ? user.content : [];
    expect(parts.some((p) => p.type === "file" && p.mediaType === "application/pdf")).toBe(true);
  });

  it("un output non conforme allo schema diventa invalid_output con i token", async () => {
    const llm = createAiSdkLlm(() => mockModel(JSON.stringify({ is_receipt: "forse" })));
    const err = await llm
      .generateStructured(request("image/jpeg", JPEG()))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("invalid_output");
    expect((err as LlmError).usage?.totalTokens).toBe(1500);
  });

  it("un errore HTTP del provider viene classificato", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(apiError(401)),
    });
    const err = await createAiSdkLlm(() => model)
      .generateStructured(request("image/jpeg", JPEG()))
      .catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe("auth");
  });
});

describe("Inngest: modalità dev", () => {
  it("vale solo con INNGEST_DEV=1 e mai in produzione", () => {
    expect(inngestDevMode(testEnv({ INNGEST_DEV: "1" }))).toBe(true);
    expect(inngestDevMode(testEnv())).toBe(false);
    expect(inngestDevMode({ ...testEnv({ INNGEST_DEV: "1" }), NODE_ENV: "production" })).toBe(
      false,
    );
  });

  it("senza signing key /api/inngest si serve solo in modalità dev", () => {
    expect(inngestServable(testEnv())).toBe(true);
    expect(inngestServable(testEnv({ INNGEST_SIGNING_KEY: "" }))).toBe(false);
    expect(inngestServable(testEnv({ INNGEST_SIGNING_KEY: "", INNGEST_DEV: "1" }))).toBe(true);
  });
});

describe("tempo a disposizione del modello", () => {
  it("un'interruzione per timeout diventa LlmError timeout", () => {
    const abort = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(classifyLlmError(abort).kind).toBe("timeout");
    const manual = new DOMException("Aborted", "AbortError");
    expect(classifyLlmError(manual).kind).toBe("timeout");
  });

  it("il budget segue la scadenza della funzione, con un margine e un massimo", () => {
    const now = Date.parse("2026-10-11T10:00:00Z");
    expect(llmBudgetMs(undefined, now)).toBe(LLM_BUDGET_MS);
    // 300 s di funzione: tetto a LLM_BUDGET_MS.
    expect(llmBudgetMs(new Date(now + 300_000), now)).toBe(LLM_BUDGET_MS);
    // 60 s (vecchi limiti): resta il margine per salvare l'esito.
    expect(llmBudgetMs(new Date(now + 60_000), now)).toBe(60_000 - LLM_BUDGET_MARGIN_MS);
    // Scadenza già passata: un minimo simbolico, la chiamata fallirà subito.
    expect(llmBudgetMs(new Date(now - 1), now)).toBe(1_000);
  });
});

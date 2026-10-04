import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { seedExtractedFile } from "../helpers/seed.js";

let h: TestApp;
let a: string;
let b: string;
let receiptId: string;
let extractionId: string;
let pendingId: string;

beforeAll(async () => {
  h = await createTestApp();
  a = await h.t.createUser();
  b = await h.t.createUser();
  const seeded = await seedExtractedFile(h.t.db, a);
  receiptId = seeded.receipt.id;
  extractionId = seeded.extraction.id;
  const res = await h.call(a, "POST", "/v1/receipts/upload-url", {
    source: "camera",
    sha256: "b".repeat(64),
    mimeType: "image/png",
    sizeBytes: 100,
  });
  pendingId = (await json<{ receiptId: string }>(res)).receiptId;
});
afterAll(() => h.close());

describe("l'utente B riceve 404 sulle risorse dell'utente A", () => {
  const cases: [string, string, () => string, unknown?][] = [
    ["GET dettaglio", "GET", () => `/v1/receipts/${receiptId}`],
    ["GET storico", "GET", () => `/v1/receipts/${receiptId}/extractions`],
    ["POST complete", "POST", () => `/v1/receipts/${pendingId}/complete`],
    ["POST reextract", "POST", () => `/v1/receipts/${receiptId}/reextract`, {}],
    ["PATCH estrazione", "PATCH", () => `/v1/extractions/${extractionId}`, { total: 1 }],
    ["DELETE", "DELETE", () => `/v1/receipts/${receiptId}`],
  ];

  it.each(cases)("%s", async (_, method, path, body) => {
    const res = await h.call(b, method, path(), body);
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("NOT_FOUND");
  });

  it("la lista di B non contiene gli scontrini di A", async () => {
    const body = await json<{ items: unknown[] }>(await h.call(b, "GET", "/v1/receipts"));
    expect(body.items).toEqual([]);
  });

  it("dopo i tentativi di B le risorse di A sono intatte", async () => {
    const d = await json<{ receipt: { status: string }; extraction: { total: number } }>(
      await h.call(a, "GET", `/v1/receipts/${receiptId}`),
    );
    expect(d.receipt.status).toBe("extracted");
    expect(d.extraction.total).toBe(12.3);
    expect((await h.call(a, "GET", `/v1/receipts/${pendingId}`)).status).toBe(200);
  });

  it("B non vede A come duplicato", async () => {
    const res = await h.call(b, "POST", "/v1/receipts/upload-url", {
      source: "camera",
      sha256: "b".repeat(64),
      mimeType: "image/png",
      sizeBytes: 100,
    });
    expect(res.status).toBe(201);
  });
});

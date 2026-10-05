import { createHash } from "node:crypto";
import { expect } from "vitest";
import { extractReceiptJob } from "../../src/jobs/extract-receipt.job.js";
import { json, type TestApp } from "./app.js";
import { JPEG, PDF } from "./fakes.js";

let fileSeq = 0;

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Il frontend: upload-url → PUT su Storage (fake) → complete. Ogni file è diverso, a meno di
 * passare i byte (es. un'immagine vera).
 */
export async function uploaded(
  app: TestApp,
  userId: string,
  kind: "jpeg" | "pdf" = "jpeg",
  content?: Uint8Array,
) {
  const bytes = content ?? (kind === "pdf" ? PDF(2048 + fileSeq++) : JPEG(2048 + fileSeq++));
  const mimeType = kind === "pdf" ? "application/pdf" : "image/jpeg";
  const res = await app.call(userId, "POST", "/v1/receipts/upload-url", {
    source: "file",
    sha256: sha(bytes),
    mimeType,
    sizeBytes: bytes.length,
  });
  expect(res.status).toBe(201);
  const { receiptId, path } = await json<{ receiptId: string; path: string }>(res);
  app.storage.put(path, bytes, mimeType);
  expect((await app.call(userId, "POST", `/v1/receipts/${receiptId}/complete`)).status).toBe(202);
  return { receiptId, bytes };
}

/** Esegue il job sugli eventi `receipt/uploaded` accodati, come farebbe Inngest. */
export async function runJobs(app: TestApp) {
  const job = extractReceiptJob(app.container.extraction);
  const pending = app.queue.events.filter((e) => e.name === "receipt/uploaded");
  app.queue.clear();
  const outcomes = [];
  for (const e of pending) outcomes.push(await job(e.data));
  return outcomes;
}

export interface Detail {
  receipt: { status: string; errorCode: string | null };
  extraction?: {
    id: string;
    merchantName: string;
    total: number;
    confidence: number;
    notes: string | null;
    provider: string;
    model: string;
    keySource: string;
    promptVersion: string;
    purchasedAt: string;
  };
  items: { description: string; amount: number }[];
  usage?: { provider: string; model: string; totalTokens: number; costUsd: number | null };
}

export const detail = async (app: TestApp, userId: string, id: string) =>
  json<Detail>(await app.call(userId, "GET", `/v1/receipts/${id}`));

export interface UsageRow {
  operation: string;
  provider: string;
  model: string;
  key_source: string;
  success: boolean;
  error_code: string | null;
  extraction_id: string | null;
  total_tokens: number | null;
  cost_usd: string | null;
}

/** Righe di `llm_usage` dello scontrino in ordine di chiamata. */
export const usageRows = (app: TestApp, receiptId: string) =>
  app.t.query<UsageRow>(
    `select * from llm_usage where receipt_id = '${receiptId}' order by created_at`,
  );

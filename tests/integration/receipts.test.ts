import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, json, type TestApp } from "../helpers/app.js";
import { JPEG, PDF } from "../helpers/fakes.js";

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

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Il frontend: upload-url → PUT su Storage (fake) → complete. */
async function upload(bytes: Uint8Array, mimeType = "image/jpeg", userId = user) {
  const res = await h.call(userId, "POST", "/v1/receipts/upload-url", {
    source: "camera",
    sha256: sha(bytes),
    mimeType,
    sizeBytes: bytes.length,
    capturedAt: "2026-10-04T09:00:00Z",
  });
  expect(res.status).toBe(201);
  const body = await json<{
    receiptId: string;
    path: string;
    uploadUrl: string;
    expiresAt: string;
  }>(res);
  h.storage.put(body.path, bytes, mimeType);
  return body;
}

const manualInput = {
  merchantName: "Bar Sport",
  purchasedAt: "2026-10-01T08:15:00+02:00",
  total: 4.5,
  paymentMethod: "contanti",
  category: "ristorazione",
  items: [
    { description: "Caffè", quantity: 2, unitPrice: 1.2, amount: 2.4 },
    { description: "Brioche", amount: 2.1, category: "alimentari" },
  ],
};

describe("upload → complete", () => {
  it("crea lo scontrino pending_upload con path {userId}/{id}.ext e scadenza a 2 minuti", async () => {
    const bytes = JPEG(2048);
    const body = await upload(bytes);
    expect(body.path).toBe(`${user}/${body.receiptId}.jpg`);
    expect(body.uploadUrl).toMatch(/^https:\/\//);
    const created = new Date(body.expiresAt).getTime();
    expect(created).toBeGreaterThan(Date.parse("2026-10-04T10:01:59Z"));

    const detail = await json<{ receipt: { status: string }; fileUrl?: string }>(
      await h.call(user, "GET", `/v1/receipts/${body.receiptId}`),
    );
    expect(detail.receipt.status).toBe("pending_upload");
    expect(detail.fileUrl).toBeUndefined();
  });

  it("complete verifica il file, imposta uploaded e accoda receipt/uploaded con i soli id", async () => {
    const { receiptId } = await upload(JPEG(3000));
    const res = await h.call(user, "POST", `/v1/receipts/${receiptId}/complete`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "uploaded" });
    expect(h.queue.events).toEqual([
      { name: "receipt/uploaded", data: { receiptId, userId: user } },
    ]);

    const detail = await json<{ receipt: { status: string }; fileUrl: string; items: unknown[] }>(
      await h.call(user, "GET", `/v1/receipts/${receiptId}`),
    );
    expect(detail.receipt.status).toBe("uploaded");
    expect(detail.fileUrl).toContain("exp=600");
    expect(detail.items).toEqual([]);
  });

  it("complete una seconda volta → 409 INVALID_STATE", async () => {
    const { receiptId } = await upload(JPEG(3001));
    await h.call(user, "POST", `/v1/receipts/${receiptId}/complete`);
    const res = await h.call(user, "POST", `/v1/receipts/${receiptId}/complete`);
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("INVALID_STATE");
  });

  it("complete senza file caricato → 409 UPLOAD_MISSING", async () => {
    const bytes = JPEG(3002);
    const res = await h.call(user, "POST", "/v1/receipts/upload-url", {
      source: "file",
      sha256: sha(bytes),
      mimeType: "image/jpeg",
      sizeBytes: bytes.length,
      originalFilename: "scontrino.jpg",
    });
    const { receiptId } = await json<{ receiptId: string }>(res);
    const c = await h.call(user, "POST", `/v1/receipts/${receiptId}/complete`);
    expect(c.status).toBe(409);
    expect((await json<{ error: { code: string } }>(c)).error.code).toBe("UPLOAD_MISSING");
  });

  it("dimensione reale diversa → 422, file e riga cancellati, nessun evento", async () => {
    const bytes = JPEG(4000);
    const { receiptId, path } = await upload(bytes);
    h.storage.put(path, JPEG(4100), "image/jpeg");
    const res = await h.call(user, "POST", `/v1/receipts/${receiptId}/complete`);
    expect(res.status).toBe(422);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("UPLOAD_MISMATCH");
    expect(h.storage.objects.has(path)).toBe(false);
    expect((await h.call(user, "GET", `/v1/receipts/${receiptId}`)).status).toBe(404);
    expect(h.queue.events).toEqual([]);
    // Lo stesso sha256 si può ricaricare.
    await upload(bytes);
  });

  it("tipo reale diverso (PDF dichiarato come JPEG) → 422", async () => {
    const declared = JPEG(5000);
    const { receiptId, path } = await upload(declared);
    h.storage.put(path, PDF(5000), "image/jpeg");
    const res = await h.call(user, "POST", `/v1/receipts/${receiptId}/complete`);
    expect(res.status).toBe(422);
  });

  it("accetta i PDF con estensione .pdf", async () => {
    const { receiptId, path } = await upload(PDF(6000), "application/pdf");
    expect(path.endsWith(".pdf")).toBe(true);
    expect((await h.call(user, "POST", `/v1/receipts/${receiptId}/complete`)).status).toBe(202);
  });
});

describe("validazione di upload-url", () => {
  const base = { source: "camera", sha256: "a".repeat(64), mimeType: "image/jpeg", sizeBytes: 10 };

  it.each([
    ["mime non ammesso", { mimeType: "image/gif" }],
    ["sha256 non valido", { sha256: "xyz" }],
    ["source manual", { source: "manual" }],
    ["dimensione negativa", { sizeBytes: -1 }],
  ])("%s → 400 VALIDATION_ERROR", async (_, patch) => {
    const res = await h.call(user, "POST", "/v1/receipts/upload-url", { ...base, ...patch });
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; requestId: string } }>(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.requestId).toBeTruthy();
  });

  it("JSON malformato o id non UUID → 400 nel formato comune", async () => {
    const res = await h.app.request("/v1/receipts/upload-url", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await h.auth.token(user)}`,
        "Content-Type": "application/json",
      },
      body: "{bad",
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("VALIDATION_ERROR");
    const bad = await h.call(user, "GET", "/v1/receipts/not-a-uuid");
    expect(bad.status).toBe(400);
  });

  it("oltre MAX_UPLOAD_BYTES → 413 FILE_TOO_LARGE", async () => {
    const res = await h.call(user, "POST", "/v1/receipts/upload-url", {
      ...base,
      sizeBytes: 10_485_761,
    });
    expect(res.status).toBe(413);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("FILE_TOO_LARGE");
  });
});

describe("duplicati", () => {
  it("stesso sha256 già caricato → 409 DUPLICATE con duplicateOf", async () => {
    const bytes = JPEG(7000);
    const { receiptId } = await upload(bytes);
    await h.call(user, "POST", `/v1/receipts/${receiptId}/complete`);
    const res = await h.call(user, "POST", "/v1/receipts/upload-url", {
      source: "file",
      sha256: sha(bytes).toUpperCase(),
      mimeType: "image/jpeg",
      sizeBytes: bytes.length,
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: { code: string; duplicateOf: string; requestId: string } }>(
      res,
    );
    expect(body.error.code).toBe("DUPLICATE");
    expect(body.error.duplicateOf).toBe(receiptId);
  });

  it("un upload mai completato non blocca un nuovo tentativo", async () => {
    const bytes = JPEG(7100);
    const first = await upload(bytes);
    const second = await upload(bytes);
    expect(second.receiptId).not.toBe(first.receiptId);
    expect((await h.call(user, "GET", `/v1/receipts/${first.receiptId}`)).status).toBe(404);
  });

  it("lo stesso file di un altro utente non è un duplicato", async () => {
    const other = await h.t.createUser();
    const bytes = JPEG(7200);
    await upload(bytes);
    await upload(bytes, "image/jpeg", other);
  });
});

describe("inserimento manuale", () => {
  it("crea raw (manual, extracted), estrazione (manual, confidence 1) e righe", async () => {
    const res = await h.call(user, "POST", "/v1/receipts/manual", manualInput);
    expect(res.status).toBe(201);
    const d = await json<{
      receipt: { id: string; source: string; status: string; sha256: null };
      fileUrl?: string;
      extraction: Record<string, unknown>;
      items: { description: string; position: number; category: string | null }[];
    }>(res);
    expect(d.receipt).toMatchObject({ source: "manual", status: "extracted", sha256: null });
    expect(d.fileUrl).toBeUndefined();
    expect(d.extraction).toMatchObject({
      method: "manual",
      confidence: 1,
      provider: null,
      keySource: null,
      merchantName: "Bar Sport",
      currency: "EUR",
      total: 4.5,
      paymentMethod: "contanti",
      category: "ristorazione",
      purchasedAt: "2026-10-01T06:15:00.000Z",
      isCurrent: true,
    });
    expect(d.items.map((i) => [i.position, i.description, i.category])).toEqual([
      [0, "Caffè", null],
      [1, "Brioche", "alimentari"],
    ]);
    expect(h.queue.events).toEqual([{ name: "stats/recompute", data: { userId: user } }]);

    const [raw] = await h.t.query<{ raw_json: { merchantName: string } }>(
      `select raw_json from extractions where receipt_id = '${d.receipt.id}'`,
    );
    expect(raw?.raw_json.merchantName).toBe("Bar Sport");
  });

  it("data senza fuso → Europe/Rome", async () => {
    const res = await h.call(user, "POST", "/v1/receipts/manual", {
      ...manualInput,
      purchasedAt: "2026-01-15",
    });
    const d = await json<{ extraction: { purchasedAt: string } }>(res);
    expect(d.extraction.purchasedAt).toBe("2026-01-14T23:00:00.000Z");
  });

  it("è transazionale: se una riga fallisce non resta nulla", async () => {
    // Un trigger fa fallire l'inserimento delle righe, dopo raw ed estrazione.
    await h.t.exec(`
      create function fail_items() returns trigger language plpgsql as $$
      begin raise exception 'boom'; end $$;
      create trigger fail_items before insert on receipt_items
        for each row when (new.description = 'BOOM') execute function fail_items();`);
    const before = await h.t.query<{ n: number }>("select count(*)::int as n from receipts_raw");
    const res = await h.call(user, "POST", "/v1/receipts/manual", {
      ...manualInput,
      items: [{ description: "BOOM" }],
      merchantName: "Rollback",
    });
    await h.t.exec("drop trigger fail_items on receipt_items; drop function fail_items();");
    expect(res.status).toBe(500);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("INTERNAL");
    expect(h.queue.events).toEqual([]);
    const after = await h.t.query<{ n: number }>("select count(*)::int as n from receipts_raw");
    expect(after[0]?.n).toBe(before[0]?.n);
    const ex = await h.t.query("select 1 from extractions where merchant_name = 'Rollback'");
    expect(ex).toEqual([]);
  });

  it("categoria o metodo di pagamento fuori lista → 400", async () => {
    const res = await h.call(user, "POST", "/v1/receipts/manual", {
      ...manualInput,
      category: "lusso",
    });
    expect(res.status).toBe(400);
  });
});

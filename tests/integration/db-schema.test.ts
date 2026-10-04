import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractions,
  llmUsage,
  receiptItems,
  receiptsRaw,
} from "../../src/infra/db/schema/index.js";
import { createTestDb, type TestDb } from "../helpers/db.js";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

const fileReceipt = (userId: string, sha256: string = randomUUID()) => {
  const id = randomUUID();
  return {
    id,
    userId,
    source: "file" as const,
    storagePath: `${userId}/${id}.jpg`,
    sha256,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    status: "pending_upload" as const,
  };
};

describe("migrazioni su DB vuoto", () => {
  it("creano tutte le tabelle della sezione 5", async () => {
    const rows = await t.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "extractions",
      "llm_usage",
      "model_prices",
      "receipt_items",
      "receipts_raw",
      "stats_monthly",
      "user_ai_settings",
      "user_api_keys",
    ]);
  });

  it("si applicano anche su un secondo DB vuoto (idempotenza del bootstrap)", async () => {
    const other = await createTestDb();
    await other.close();
  });
});

describe("vincoli di receipts_raw", () => {
  it("source=manual senza file è ammesso", async () => {
    const userId = await t.createUser();
    await t.db.insert(receiptsRaw).values({ userId, source: "manual", status: "extracted" });
  });

  it("source=file senza storage_path o sha256 viola il CHECK", async () => {
    const userId = await t.createUser();
    await expect(
      t.db.insert(receiptsRaw).values({ userId, source: "file", status: "pending_upload" }),
    ).rejects.toThrow();
  });

  it("sha256 è unico per utente, non tra utenti diversi", async () => {
    const a = await t.createUser();
    const b = await t.createUser();
    await t.db.insert(receiptsRaw).values(fileReceipt(a, "same-hash"));
    await expect(t.db.insert(receiptsRaw).values(fileReceipt(a, "same-hash"))).rejects.toThrow();
    await t.db.insert(receiptsRaw).values(fileReceipt(b, "same-hash"));
  });

  it("storage_path fuori dalla cartella del proprietario viola il CHECK", async () => {
    const a = await t.createUser();
    const b = await t.createUser();
    await expect(
      t.db.insert(receiptsRaw).values({ ...fileReceipt(a), storagePath: `${b}/altro.jpg` }),
    ).rejects.toThrow();
  });

  it("un utente inesistente viola la FK verso auth.users", async () => {
    await expect(t.db.insert(receiptsRaw).values(fileReceipt(randomUUID()))).rejects.toThrow();
  });
});

describe("estrazioni", () => {
  it("una sola estrazione corrente per scontrino; lo storico resta", async () => {
    const userId = await t.createUser();
    const receipt = fileReceipt(userId);
    await t.db.insert(receiptsRaw).values(receipt);
    const base = { receiptId: receipt.id, userId, method: "llm" as const, rawJson: {} };

    await t.db.insert(extractions).values(base);
    await expect(t.db.insert(extractions).values(base)).rejects.toThrow();
    await t.db.insert(extractions).values({ ...base, isCurrent: false });

    const rows = await t.db.select().from(extractions).where(eq(extractions.receiptId, receipt.id));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.isCurrent)?.currency).toBe("EUR");
  });

  it("gli importi numeric tornano come number", async () => {
    const userId = await t.createUser();
    const receipt = fileReceipt(userId);
    await t.db.insert(receiptsRaw).values(receipt);
    const [extraction] = await t.db
      .insert(extractions)
      .values({ receiptId: receipt.id, userId, method: "manual", rawJson: {}, total: 12.34 })
      .returning();
    expect(extraction?.total).toBe(12.34);
  });

  it("cancellare il raw cancella estrazioni e righe; llm_usage resta con receipt_id null", async () => {
    const userId = await t.createUser();
    const receipt = fileReceipt(userId);
    await t.db.insert(receiptsRaw).values(receipt);
    const [extraction] = await t.db
      .insert(extractions)
      .values({ receiptId: receipt.id, userId, method: "llm", rawJson: {} })
      .returning();
    if (!extraction) throw new Error("estrazione non creata");
    await t.db.insert(receiptItems).values({
      extractionId: extraction.id,
      userId,
      position: 0,
      description: "Pane",
      amount: 2.5,
    });
    const [usage] = await t.db
      .insert(llmUsage)
      .values({
        userId,
        receiptId: receipt.id,
        extractionId: extraction.id,
        operation: "extract",
        provider: "anthropic",
        model: "fake-model",
        keySource: "platform",
        latencyMs: 10,
        success: true,
      })
      .returning();

    await t.db.delete(receiptsRaw).where(eq(receiptsRaw.id, receipt.id));

    expect(
      await t.db.select().from(extractions).where(eq(extractions.receiptId, receipt.id)),
    ).toHaveLength(0);
    expect(
      await t.db.select().from(receiptItems).where(eq(receiptItems.extractionId, extraction.id)),
    ).toHaveLength(0);
    const [kept] = await t.db
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.id, usage?.id ?? ""));
    expect(kept?.receiptId).toBeNull();
    expect(kept?.extractionId).toBeNull();
  });
});

describe("isolamento tra utenti nelle righe figlie", () => {
  it("un'estrazione non può puntare allo scontrino di un altro utente", async () => {
    const a = await t.createUser();
    const b = await t.createUser();
    const receipt = fileReceipt(a);
    await t.db.insert(receiptsRaw).values(receipt);
    await expect(
      t.db
        .insert(extractions)
        .values({ receiptId: receipt.id, userId: b, method: "llm", rawJson: {} }),
    ).rejects.toThrow();
  });

  it("una riga non può puntare all'estrazione di un altro utente", async () => {
    const a = await t.createUser();
    const b = await t.createUser();
    const receipt = fileReceipt(a);
    await t.db.insert(receiptsRaw).values(receipt);
    const [extraction] = await t.db
      .insert(extractions)
      .values({ receiptId: receipt.id, userId: a, method: "llm", rawJson: {} })
      .returning();
    await expect(
      t.db.insert(receiptItems).values({
        extractionId: extraction?.id ?? "",
        userId: b,
        position: 0,
        description: "Pane",
      }),
    ).rejects.toThrow();
  });
});

describe("cancellazione dell'utente", () => {
  it("rimuove tutte le sue righe", async () => {
    const userId = await t.createUser();
    await t.db.insert(receiptsRaw).values(fileReceipt(userId));
    await t.db.execute(sql`delete from auth.users where id = ${userId}`);
    expect(
      await t.db.select().from(receiptsRaw).where(eq(receiptsRaw.userId, userId)),
    ).toHaveLength(0);
  });
});

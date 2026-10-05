import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../infra/db/client.js";
import { extractions, llmUsage, receiptItems, receiptsRaw } from "../../infra/db/schema/index.js";
import type { NewLlmUsage } from "../usage/usage.repo.js";

export type ExtractionRow = typeof extractions.$inferSelect;
export type ItemRow = typeof receiptItems.$inferSelect;
export type ExtractionWithItems = ExtractionRow & { items: ItemRow[] };

export type ExtractionFields = Partial<
  Pick<
    ExtractionRow,
    | "merchantName"
    | "merchantBrand"
    | "merchantVat"
    | "merchantAddress"
    | "purchasedAt"
    | "currency"
    | "total"
    | "taxTotal"
    | "paymentMethod"
    | "category"
    | "notes"
  >
>;

export type ItemFields = Pick<
  ItemRow,
  | "description"
  | "quantity"
  | "unitPrice"
  | "amount"
  | "vatRate"
  | "category"
  | "normalizedName"
  | "brand"
  | "size"
  | "sizeUnit"
>;

export interface ManualReceiptValues {
  createdAt: Date;
  fields: ExtractionFields;
  rawJson: unknown;
  items: ItemFields[];
}

export interface LlmExtractionValues {
  receiptId: string;
  provider: string;
  model: string;
  keySource: "platform" | "user";
  promptVersion: string;
  rawJson: unknown;
  confidence: number;
  fields: ExtractionFields;
  items: ItemFields[];
  /** Tutte le chiamate fatte per questa estrazione, comprese quelle fallite. */
  usage: NewLlmUsage[];
  /** Indice in `usage` della chiamata che ha prodotto l'estrazione. */
  successfulCall: number;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const insertItems = async (
  tx: Tx | Db,
  userId: string,
  extractionId: string,
  items: ItemFields[],
) => {
  if (items.length === 0) return [];
  return tx
    .insert(receiptItems)
    .values(items.map((it, position) => ({ ...it, position, extractionId, userId })))
    .returning();
};

/** Unico accesso a `extractions` e `receipt_items`: ogni query filtra per `userId`. */
export function createExtractionsRepo(db: Db) {
  const withItems = async (
    userId: string,
    rows: ExtractionRow[],
  ): Promise<ExtractionWithItems[]> => {
    if (rows.length === 0) return [];
    const items = await db
      .select()
      .from(receiptItems)
      .where(
        and(
          eq(receiptItems.userId, userId),
          inArray(
            receiptItems.extractionId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(asc(receiptItems.position));
    return rows.map((r) => ({ ...r, items: items.filter((i) => i.extractionId === r.id) }));
  };

  return {
    /** Crea in un'unica transazione raw (manual, extracted), estrazione e righe. */
    async createManualReceipt(userId: string, v: ManualReceiptValues) {
      return db.transaction(async (tx) => {
        const [receipt] = await tx
          .insert(receiptsRaw)
          .values({ userId, source: "manual", status: "extracted", createdAt: v.createdAt })
          .returning();
        if (!receipt) throw new Error("insert receipts_raw senza risultato");
        const [extraction] = await tx
          .insert(extractions)
          .values({
            ...v.fields,
            userId,
            receiptId: receipt.id,
            method: "manual",
            rawJson: v.rawJson,
            confidence: 1,
          })
          .returning();
        if (!extraction) throw new Error("insert extractions senza risultato");
        const items = await insertItems(tx, userId, extraction.id, v.items);
        return { receipt, extraction: { ...extraction, items } };
      });
    },

    /**
     * In un'unica transazione: la vecchia estrazione esce dallo stato corrente (resta nello
     * storico), si salvano la nuova con le righe e le chiamate in `llm_usage`, lo scontrino
     * diventa `extracted`.
     */
    async saveLlmExtraction(userId: string, v: LlmExtractionValues) {
      return db.transaction(async (tx) => {
        await tx
          .update(extractions)
          .set({ isCurrent: false })
          .where(
            and(
              eq(extractions.userId, userId),
              eq(extractions.receiptId, v.receiptId),
              eq(extractions.isCurrent, true),
            ),
          );
        const [extraction] = await tx
          .insert(extractions)
          .values({
            ...v.fields,
            userId,
            receiptId: v.receiptId,
            method: "llm",
            provider: v.provider,
            model: v.model,
            keySource: v.keySource,
            promptVersion: v.promptVersion,
            rawJson: v.rawJson,
            confidence: v.confidence,
          })
          .returning();
        if (!extraction) throw new Error("insert extractions senza risultato");
        await insertItems(tx, userId, extraction.id, v.items);
        if (v.usage.length > 0) {
          await tx.insert(llmUsage).values(
            v.usage.map((u, i) => ({
              ...u,
              userId,
              ...(i === v.successfulCall ? { extractionId: extraction.id } : {}),
            })),
          );
        }
        await tx
          .update(receiptsRaw)
          .set({ status: "extracted", errorCode: null })
          .where(and(eq(receiptsRaw.userId, userId), eq(receiptsRaw.id, v.receiptId)));
        return extraction;
      });
    },

    async findById(userId: string, id: string): Promise<ExtractionRow | undefined> {
      const [row] = await db
        .select()
        .from(extractions)
        .where(and(eq(extractions.userId, userId), eq(extractions.id, id)));
      return row;
    },

    async findCurrent(userId: string, receiptId: string): Promise<ExtractionWithItems | undefined> {
      const rows = await db
        .select()
        .from(extractions)
        .where(
          and(
            eq(extractions.userId, userId),
            eq(extractions.receiptId, receiptId),
            eq(extractions.isCurrent, true),
          ),
        );
      const [first] = await withItems(userId, rows);
      return first;
    },

    async listByReceipt(userId: string, receiptId: string): Promise<ExtractionWithItems[]> {
      const rows = await db
        .select()
        .from(extractions)
        .where(and(eq(extractions.userId, userId), eq(extractions.receiptId, receiptId)))
        .orderBy(desc(extractions.createdAt), desc(extractions.id));
      return withItems(userId, rows);
    },

    /** Aggiorna i campi, marca `edited_by_user` e, se passate, sostituisce tutte le righe. */
    async update(
      userId: string,
      id: string,
      fields: ExtractionFields,
      items: ItemFields[] | undefined,
    ): Promise<ExtractionWithItems | undefined> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(extractions)
          .set({ ...fields, editedByUser: true })
          .where(and(eq(extractions.userId, userId), eq(extractions.id, id)))
          .returning();
        if (!row) return undefined;
        if (items) {
          await tx
            .delete(receiptItems)
            .where(and(eq(receiptItems.userId, userId), eq(receiptItems.extractionId, id)));
          await insertItems(tx, userId, id, items);
        }
        const current = await tx
          .select()
          .from(receiptItems)
          .where(and(eq(receiptItems.userId, userId), eq(receiptItems.extractionId, id)))
          .orderBy(asc(receiptItems.position));
        return { ...row, items: current };
      });
    },
  };
}

export type ExtractionsRepo = ReturnType<typeof createExtractionsRepo>;

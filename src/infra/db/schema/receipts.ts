import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  extractionMethod,
  keySource,
  receiptSource,
  receiptStatus,
  updatedAt,
  userIdColumn,
} from "./common.js";

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" });

export const receiptsRaw = pgTable(
  "receipts_raw",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userIdColumn(),
    source: receiptSource("source").notNull(),
    storagePath: text("storage_path").unique(),
    originalFilename: text("original_filename"),
    sha256: text("sha256"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    status: receiptStatus("status").notNull(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "receipts_raw_file_check",
      sql`${t.source} = 'manual' or (${t.storagePath} is not null and ${t.sha256} is not null)`,
    ),
    // Il file deve stare nella cartella del proprietario: `{user_id}/{id}.{ext}`.
    check(
      "receipts_raw_storage_path_owner_check",
      sql`${t.storagePath} is null or starts_with(${t.storagePath}, ${t.userId}::text || '/')`,
    ),
    // Destinazione delle FK composte: una riga figlia non può appartenere a un altro utente.
    unique("receipts_raw_id_user_uq").on(t.id, t.userId),
    uniqueIndex("receipts_raw_user_sha256_uq")
      .on(t.userId, t.sha256)
      .where(sql`${t.sha256} is not null`),
    index("receipts_raw_user_created_idx").on(t.userId, t.createdAt.desc()),
  ],
);

export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id").notNull(),
    userId: userIdColumn(),
    method: extractionMethod("method").notNull(),
    provider: text("provider"),
    model: text("model"),
    keySource: keySource("key_source"),
    promptVersion: text("prompt_version"),
    rawJson: jsonb("raw_json").notNull(),
    merchantName: text("merchant_name"),
    /** Insegna del negozio ("Lidl", "IN's"), distinta dalla ragione sociale. */
    merchantBrand: text("merchant_brand"),
    merchantVat: text("merchant_vat"),
    merchantAddress: text("merchant_address"),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }),
    currency: char("currency", { length: 3 }).notNull().default("EUR"),
    total: money("total"),
    taxTotal: money("tax_total"),
    paymentMethod: text("payment_method"),
    category: text("category"),
    confidence: real("confidence"),
    notes: text("notes"),
    isCurrent: boolean("is_current").notNull().default(true),
    editedByUser: boolean("edited_by_user").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "extractions_receipt_owner_fk",
      columns: [t.receiptId, t.userId],
      foreignColumns: [receiptsRaw.id, receiptsRaw.userId],
    }).onDelete("cascade"),
    unique("extractions_id_user_uq").on(t.id, t.userId),
    uniqueIndex("extractions_current_uq")
      .on(t.receiptId)
      .where(sql`${t.isCurrent}`),
    index("extractions_receipt_idx").on(t.receiptId),
    index("extractions_user_purchased_idx").on(t.userId, t.purchasedAt),
  ],
);

export const receiptItems = pgTable(
  "receipt_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extractionId: uuid("extraction_id").notNull(),
    userId: userIdColumn(),
    position: integer("position").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 3, mode: "number" }),
    unitPrice: money("unit_price"),
    amount: money("amount"),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2, mode: "number" }),
    category: text("category"),
    /** Nome del prodotto senza marca né formato ("Latte intero"), per confrontare gli acquisti. */
    normalizedName: text("normalized_name"),
    brand: text("brand"),
    /** Formato della confezione: quantità e unità (g, kg, ml, cl, l, pz). */
    size: numeric("size", { precision: 10, scale: 3, mode: "number" }),
    sizeUnit: text("size_unit"),
  },
  (t) => [
    foreignKey({
      name: "receipt_items_extraction_owner_fk",
      columns: [t.extractionId, t.userId],
      foreignColumns: [extractions.id, extractions.userId],
    }).onDelete("cascade"),
    index("receipt_items_extraction_idx").on(t.extractionId, t.position),
  ],
);

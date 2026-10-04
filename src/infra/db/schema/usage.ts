import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, keySource, llmOperation, updatedAt, userIdColumn } from "./common.js";
import { extractions, receiptsRaw } from "./receipts.js";

export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userIdColumn(),
    receiptId: uuid("receipt_id").references(() => receiptsRaw.id, { onDelete: "set null" }),
    extractionId: uuid("extraction_id").references(() => extractions.id, {
      onDelete: "set null",
    }),
    operation: llmOperation("operation").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    keySource: keySource("key_source").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }),
    latencyMs: integer("latency_ms").notNull(),
    success: boolean("success").notNull(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [index("llm_usage_user_created_idx").on(t.userId, t.createdAt.desc())],
);

/** Prezzi per milione di token. Seed vuoto: se manca il prezzo, `cost_usd` resta null. */
export const modelPrices = pgTable(
  "model_prices",
  {
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputPerMtokUsd: numeric("input_per_mtok_usd", {
      precision: 12,
      scale: 6,
      mode: "number",
    }).notNull(),
    outputPerMtokUsd: numeric("output_per_mtok_usd", {
      precision: 12,
      scale: 6,
      mode: "number",
    }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.model] })],
);

export const statsMonthly = pgTable(
  "stats_monthly",
  {
    userId: userIdColumn(),
    month: date("month", { mode: "string" }).notNull(),
    category: text("category").notNull(),
    total: numeric("total", { precision: 12, scale: 2, mode: "number" }).notNull(),
    nReceipts: integer("n_receipts").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.month, t.category] })],
);

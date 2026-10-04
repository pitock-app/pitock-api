import { pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

export const receiptSource = pgEnum("receipt_source", ["camera", "file", "manual"]);
export const receiptStatus = pgEnum("receipt_status", [
  "pending_upload",
  "uploaded",
  "processing",
  "extracted",
  "failed",
]);
export const extractionMethod = pgEnum("extraction_method", ["llm", "manual"]);
export const keySource = pgEnum("key_source", ["platform", "user"]);
export const aiMode = pgEnum("ai_mode", ["platform", "byok"]);
export const llmOperation = pgEnum("llm_operation", ["extract", "reextract", "key_test"]);

/** Riferimento all'utente proprietario: le righe spariscono con l'utente. */
export const userIdColumn = () =>
  uuid("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" });

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

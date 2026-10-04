import { boolean, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { aiMode, createdAt, updatedAt, userIdColumn } from "./common.js";

export const userAiSettings = pgTable("user_ai_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  mode: aiMode("mode").notNull().default("platform"),
  provider: text("provider"),
  model: text("model"),
  fallbackToPlatform: boolean("fallback_to_platform").notNull().default(false),
  updatedAt: updatedAt(),
});

/** Chiavi BYOK cifrate (AES-256-GCM, vedi infra/crypto/key-cipher.ts). Mai leggibili via RLS. */
export const userApiKeys = pgTable(
  "user_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userIdColumn(),
    provider: text("provider").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    last4: text("last4").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("user_api_keys_user_provider_uq").on(t.userId, t.provider)],
);

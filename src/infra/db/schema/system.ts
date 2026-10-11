import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { updatedAt, userIdColumn } from "./common.js";

/**
 * Contatori del rate limit, condivisi tra tutte le istanze. Una riga per `bucket:userId`;
 * le righe scadute si azzerano al primo uso e il cron cancella quelle vecchie.
 * Nessuna policy RLS: è accessibile solo dal backend.
 */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

/**
 * Nome armonizzato di ogni variante di negozio dell'utente (vedi `merchants.ts`), calcolato
 * sull'intero storico dal job `recompute-stats`. `variant_key` è `[nome, marca, partita IVA]`
 * in JSON; `name` è null se la variante non ha un nome utilizzabile.
 */
export const merchantNames = pgTable(
  "merchant_names",
  {
    userId: userIdColumn(),
    variantKey: text("variant_key").notNull(),
    name: text("name"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.variantKey] })],
);

import { sql, type SQL } from "drizzle-orm";

/**
 * Data come parametro `timestamptz` esplicito, per i confronti con espressioni SQL
 * (es. `coalesce(...)`) che non hanno una colonna da cui Drizzle ricavi il tipo.
 * Senza il cast postgres-js serializza la `Date` con `toString()` e Postgres la rifiuta.
 */
export function timestamptz(date: Date): SQL {
  return sql`${date.toISOString()}::timestamptz`;
}

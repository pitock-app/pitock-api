import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export { schema };

/** Database indipendente dal driver: postgres-js in produzione, PGlite nei test. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/**
 * Crea il client Postgres. Va chiamato solo quando serve il database:
 * l'app deve poter partire anche senza `DATABASE_URL`.
 * `prepare: false` è richiesto dal pooler di Supabase in modalità transaction.
 */
export function createDb(databaseUrl: string): DbHandle {
  const client = postgres(databaseUrl, { prepare: false, max: 1 });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

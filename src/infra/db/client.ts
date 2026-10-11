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
 * `prepare: false` è richiesto dal pooler di Supabase in modalità transaction, che ignora
 * anche i parametri di sessione (`statement_timeout` resta quello del ruolo).
 *
 * Timeout lato client: una connessione che non si apre fallisce in 10 s; quelle inattive si
 * chiudono dopo 20 s e nessuna vive oltre 5 minuti, così un'istanza congelata e poi ripresa
 * non riusa un socket che il pooler ha già chiuso o lasciato a metà.
 */
export function createDb(databaseUrl: string): DbHandle {
  const client = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    connect_timeout: 10,
    idle_timeout: 20,
    max_lifetime: 5 * 60,
  });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../../src/infra/db/client.js";
import * as schema from "../../src/infra/db/schema/index.js";

export interface TestDb {
  db: Db;
  /** Inserisce un utente nello stub di `auth.users` e ne restituisce l'id. */
  createUser: () => Promise<string>;
  /** Query SQL grezza, per ispezionare il catalogo nei test. */
  query: <T>(text: string) => Promise<T[]>;
  /** Uno o più statement SQL senza risultato (es. trigger di test). */
  exec: (text: string) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Postgres in memoria (PGlite) con lo stub di `auth.users` e le migrazioni Drizzle applicate.
 * La migrazione Supabase (drizzle/supabase/) non si applica: richiede ruoli e schema `storage`.
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  await client.exec("create schema auth; create table auth.users (id uuid primary key);");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });

  return {
    db,
    createUser: async () => {
      const id = randomUUID();
      await db.execute(sql`insert into auth.users (id) values (${id})`);
      return id;
    },
    query: async <T>(text: string) => (await client.query<T>(text)).rows,
    exec: async (text: string) => {
      await client.exec(text);
    },
    close: () => client.close(),
  };
}

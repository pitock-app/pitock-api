import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Applica a DATABASE_URL le migrazioni generate da Drizzle (drizzle/)
// e poi quelle specifiche di Supabase scritte a mano (drizzle/supabase/, idempotenti).
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL mancante: imposta la stringa di connessione di Supabase.");
  process.exit(1);
}

/**
 * Il pooler di Supabase in modalità transaction (porta 6543) ignora i parametri di sessione,
 * compresi quelli passati alla connessione: le migrazioni passano dal pooler in modalità
 * session (porta 5432 dello stesso host), dove un `SET` vale per tutta la connessione.
 * `MIGRATION_DATABASE_URL` permette di indicare un'altra stringa (es. connessione diretta).
 */
function migrationUrl(url: string): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".pooler.supabase.com") && parsed.port === "6543") {
      parsed.port = "5432";
      return parsed.toString();
    }
  } catch {
    // Stringa non in formato URL: si usa così com'è.
  }
  return url;
}

const client = postgres(migrationUrl(databaseUrl), { prepare: false, max: 1 });
const db = drizzle(client);

try {
  // Se una query dell'API tiene un lock su una tabella da modificare, la migrazione fallisce
  // dopo 10 s invece di restare in coda (bloccando a sua volta le letture) fino allo
  // statement_timeout. Con `max: 1` il SET vale per tutte le istruzioni che seguono.
  await client`set lock_timeout = '10s'`;
  await migrate(db, { migrationsFolder: "drizzle" });
  console.log("Migrazioni Drizzle applicate.");

  const dir = join("drizzle", "supabase");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await db.execute(sql.raw(await readFile(join(dir, file), "utf8")));
    console.log(`Applicata ${file}.`);
  }
} finally {
  await client.end();
}

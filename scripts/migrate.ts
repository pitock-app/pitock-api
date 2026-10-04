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

const client = postgres(databaseUrl, { prepare: false, max: 1 });
const db = drizzle(client);

try {
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

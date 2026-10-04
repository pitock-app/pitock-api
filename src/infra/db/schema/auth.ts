import { pgSchema, uuid } from "drizzle-orm/pg-core";

/**
 * `auth.users` appartiene a Supabase Auth: è dichiarata solo come destinazione delle FK.
 * Non è esportata da `index.ts`, così drizzle-kit non la include nelle migrazioni.
 * Nei test la crea lo stub di tests/helpers/db.ts.
 */
const auth = pgSchema("auth");

export const authUsers = auth.table("users", {
  id: uuid("id").primaryKey(),
});

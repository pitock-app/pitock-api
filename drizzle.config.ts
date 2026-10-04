import { defineConfig } from "drizzle-kit";

// Genera solo lo schema `public`: `auth.users` appartiene a Supabase Auth.
// Le migrazioni specifiche di Supabase (RLS, bucket) stanno in drizzle/supabase/.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infra/db/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["public"],
  strict: true,
  verbose: true,
  ...(process.env.DATABASE_URL ? { dbCredentials: { url: process.env.DATABASE_URL } } : {}),
});

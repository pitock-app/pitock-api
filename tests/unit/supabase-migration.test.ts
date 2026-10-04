import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// La migrazione Supabase non si può eseguire su PGlite: ne controlliamo almeno il contenuto.
const TABLES = [
  "receipts_raw",
  "extractions",
  "receipt_items",
  "user_ai_settings",
  "user_api_keys",
  "llm_usage",
  "model_prices",
  "stats_monthly",
];

describe("drizzle/supabase/0000_rls_and_storage.sql", async () => {
  const content = await readFile("drizzle/supabase/0000_rls_and_storage.sql", "utf8");

  it.each(TABLES)("abilita RLS su %s", (table) => {
    expect(content).toContain(`alter table public.${table} enable row level security;`);
  });

  it.each(TABLES.filter((t) => t !== "user_api_keys" && t !== "model_prices"))(
    "policy di lettura del proprietario su %s",
    (table) => {
      const policy = new RegExp(
        `create policy \\w+ on public\\.${table}\\s+for select to authenticated using \\(user_id = \\(select auth\\.uid\\(\\)\\)\\);`,
      );
      expect(content).toMatch(policy);
    },
  );

  it("revoca i privilegi client su user_api_keys", () => {
    expect(content).toContain("revoke all on table public.user_api_keys from anon, authenticated;");
  });

  it("nessuna policy su user_api_keys", () => {
    expect(content).not.toMatch(/create policy \w+ on public\.user_api_keys/);
  });

  it("crea il bucket privato receipts", () => {
    expect(content).toContain("values ('receipts', 'receipts', false, 10485760,");
    expect(content).toContain("set public = false");
  });

  it("limita dimensione e tipi del bucket", () => {
    expect(content).toContain("array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']");
  });
});

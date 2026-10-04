-- Migrazione scritta a mano, specifica di Supabase.
-- Va applicata DOPO le migrazioni generate da Drizzle (drizzle/*.sql): `pnpm db:migrate` lo fa in automatico.
-- Non si applica nei test (PGlite non ha i ruoli, `auth.uid()` né `storage`).
-- È idempotente: si può rieseguire senza errori.
--
-- Difesa in profondità: il backend usa un ruolo privilegiato e filtra sempre per user_id.
-- Le policy concedono al ruolo `authenticated` solo la LETTURA delle proprie righe:
-- il frontend non scrive mai direttamente sul database.

alter table public.receipts_raw enable row level security;
alter table public.extractions enable row level security;
alter table public.receipt_items enable row level security;
alter table public.user_ai_settings enable row level security;
alter table public.user_api_keys enable row level security;
alter table public.llm_usage enable row level security;
alter table public.model_prices enable row level security;
alter table public.stats_monthly enable row level security;

drop policy if exists receipts_raw_owner_select on public.receipts_raw;
create policy receipts_raw_owner_select on public.receipts_raw
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists extractions_owner_select on public.extractions;
create policy extractions_owner_select on public.extractions
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists receipt_items_owner_select on public.receipt_items;
create policy receipt_items_owner_select on public.receipt_items
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists user_ai_settings_owner_select on public.user_ai_settings;
create policy user_ai_settings_owner_select on public.user_ai_settings
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists llm_usage_owner_select on public.llm_usage;
create policy llm_usage_owner_select on public.llm_usage
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists stats_monthly_owner_select on public.stats_monthly;
create policy stats_monthly_owner_select on public.stats_monthly
  for select to authenticated using (user_id = (select auth.uid()));

-- user_api_keys: RLS attiva e nessuna policy. Solo il backend (ruolo privilegiato) vi accede.
-- model_prices: RLS attiva e nessuna policy. I prezzi arrivano al frontend solo tramite le API.

-- I ruoli client non hanno alcun privilegio sulle chiavi cifrate, nemmeno con RLS disattivata per errore.
revoke all on table public.user_api_keys from anon, authenticated;

-- Bucket privato per i file raw. Nessuna policy su storage.objects:
-- upload e lettura passano solo da URL firmati emessi dal backend.
-- Il bucket limita anche dimensione e tipo: gli URL firmati di upload non possono
-- caricare altro. Il limite va tenuto allineato a MAX_UPLOAD_BYTES.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

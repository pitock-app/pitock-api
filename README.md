# pitock-api

Backend di Pitock: API HTTP (Hono + `@hono/zod-openapi`) per raccogliere scontrini, estrarne i dati con un LLM e calcolare statistiche di spesa.

## Requisiti

- Node.js 24 (LTS)
- pnpm 12 (`corepack enable`)

## Avvio locale

```sh
pnpm install
cp .env.example .env   # compila i valori che servono
pnpm dev               # http://localhost:8787/health
```

In sviluppo e test il server parte anche senza `DATABASE_URL` e senza segreti; in produzione (`NODE_ENV=production`) sono obbligatori.

## Script

| Script                  | Cosa fa                                |
| ----------------------- | -------------------------------------- |
| `pnpm dev`              | server locale su :8787 (legge `.env`)  |
| `pnpm lint`             | ESLint + controllo Prettier            |
| `pnpm format`           | formatta con Prettier                  |
| `pnpm typecheck`        | `tsc --noEmit`                         |
| `pnpm test`             | test unitari (Vitest)                  |
| `pnpm test:integration` | test di integrazione                   |
| `pnpm build`            | compila in `dist/`                     |
| `pnpm db:generate`      | genera le migrazioni Drizzle           |
| `pnpm db:migrate`       | applica le migrazioni a `DATABASE_URL` |
| `pnpm openapi:export`   | scrive `openapi.json` nella root       |
| `pnpm inngest:dev`      | Dev Server Inngest su `/api/inngest`   |
| `pnpm simulate:upload`  | simula il frontend su file o cartelle  |

## Database

- Schema Drizzle in `src/infra/db/schema/`; migrazioni generate in `drizzle/` (`pnpm db:generate`).
- `drizzle/supabase/0000_rls_and_storage.sql` è scritta a mano: abilita la RLS, crea le policy e il bucket privato `receipts`. Non si applica nei test.
- `pnpm db:migrate` applica a `DATABASE_URL` prima le migrazioni Drizzle, poi quelle in `drizzle/supabase/`.
- I test di integrazione usano PGlite (Postgres in memoria) con uno stub di `auth.users`: non serve Docker.

## Endpoint

- `GET /health` → `{ ok, version }` (pubblico)
- `GET /openapi.json` → contratto OpenAPI 3.1 (pubblico); copia committata in `openapi.json`, aggiornata con `pnpm openapi:export`.
- `/v1/*` → richiedono `Authorization: Bearer <access_token Supabase>`: `/v1/me`, `/v1/receipts*`, `PATCH /v1/extractions/{id}`, `/v1/settings/ai*`, `/v1/usage*`, `/v1/stats`, `DELETE /v1/account`. L'elenco completo è nel contratto.

## Impostazioni AI e consumo

- `PUT /v1/settings/ai/keys/{provider}` verifica la chiave sul provider (senza consumare token), la cifra con AES-256-GCM e la salva: le risposte contengono solo `last4`.
- `PUT /v1/settings/ai` sceglie `platform` o `byok` (provider, modello, fallback sulla piattaforma); l'estrazione successiva usa la nuova scelta.
- `GET /v1/settings/ai/models?provider=` carica l'elenco dei modelli dal provider (`src/infra/llm/model-catalog.adapter.ts`); `POST /v1/settings/ai/test` fa una chiamata minima, registrata in `llm_usage` come `key_test`.
- `GET /v1/usage` e `GET /v1/usage/calls` leggono `llm_usage`; il costo è `cost_usd` oppure, se manca, il prezzo corrente in `model_prices` (seed vuoto: inserisci i prezzi a mano).

## Statistiche e account

- `GET /v1/stats?from&to&granularity=month|year` calcola totali, categorie, periodi (Europe/Rome), primi 10 esercenti e sorgenti dalle estrazioni correnti degli scontrini `extracted`. La data di uno scontrino è quella d'acquisto o, se manca, quella di caricamento.
- `stats_monthly` (mese × categoria) viene riscritta dalla funzione Inngest `recompute-stats` (evento `stats/recompute`, inviato dopo ogni estrazione, correzione, inserimento manuale o cancellazione) e dal cron giornaliero `GET /cron/recompute-stats` (`Authorization: Bearer CRON_SECRET`, inviato da Vercel Cron), che ricalcola tutti gli utenti.
- `DELETE /v1/account` con `{ "confirm": "ELIMINA" }` cancella i file da Storage, tutte le righe dell'utente e infine l'utente di Supabase Auth (`auth.admin.deleteUser`, service role key). Ogni passo è idempotente: dopo un errore si può ripetere.

## Estrazione

1. `POST /v1/receipts/{id}/complete` accoda l'evento Inngest `receipt/uploaded` con i soli id.
2. La funzione `extract-receipt` (`/api/inngest`) porta lo scontrino in `processing`, sceglie provider, modello e chiave con l'AI router (piattaforma con quota mensile, oppure BYOK con eventuale fallback), scarica il file e chiama il modello con `generateText` + output Zod (1 retry se l'output non è valido).
3. Post-processing (somma delle righe contro il totale, date in Europe/Rome), poi estrazione, righe e `llm_usage` in un'unica transazione. Lo scontrino diventa `extracted`, oppure `failed` con `errorCode`.

In locale: imposta `INNGEST_DEV=1` nel `.env` (senza firma, solo in sviluppo), poi `pnpm dev` in un terminale e `pnpm inngest:dev` in un altro. Poi, con `SIMULATE_EMAIL`, `SIMULATE_PASSWORD`, `SUPABASE_URL` e `SUPABASE_ANON_KEY` nel `.env`:

```sh
pnpm simulate:upload fixtures/receipts
```

## Architettura

- `src/app.ts`: middleware (request id, log con redazione, secure headers, CORS, auth, rate limit, errori) e rotte.
- `src/container.ts`: `createContainer(env)` crea gli adapter reali (Postgres, Supabase Storage, Inngest, JWKS); `buildContainer(env, infra)` costruisce i servizi, anche nei test con PGlite e fake.
- `src/modules/*`: rotte → servizi → repository. Solo i repository contengono query, sempre filtrate per `userId`.
- `src/ports/*`: interfacce di Storage, LLM, catalogo dei modelli, coda e orologio.
- `src/infra/llm/ai-sdk.adapter.ts`: Vercel AI SDK (Anthropic, OpenAI, OpenRouter); `src/infra/queue/`: client e funzioni Inngest; `src/jobs/`: job asincroni.

## Deploy su Vercel

1. Crea su Vercel un progetto dedicato `pitock-api` collegato a questo repository (framework: Hono, rilevato in automatico; entry `src/index.ts`).
2. Imposta le variabili d'ambiente elencate in `.env.example`. Con `NODE_ENV=production` l'avvio si ferma se manca una variabile di `REQUIRED_IN_PRODUCTION` (`src/config/env.ts`).
3. Fai il deploy e verifica `https://<dominio>/health`.

Il cron giornaliero (03:00 UTC) su `/cron/recompute-stats` è configurato in `vercel.json`: Vercel invia `Authorization: Bearer $CRON_SECRET`, quindi `CRON_SECRET` va impostata nelle env del progetto.

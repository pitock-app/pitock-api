import { parseEnv, type Env } from "../../src/config/env.js";

/** Valori fittizi per i test: nessun segreto reale, nessun servizio esterno. */
export const TEST_ENV_SOURCE: Record<string, string> = {
  NODE_ENV: "test",
  APP_VERSION: "0.0.0-test",
  ALLOWED_ORIGINS: "http://localhost:3000",
  ALLOWED_ORIGIN_REGEX: "^https://pitock-web-.*\\.vercel\\.app$",
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_JWKS_URL: "http://supabase.test/auth/v1/.well-known/jwks.json",
  SUPABASE_JWT_ISSUER: "http://supabase.test/auth/v1",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  KEY_ENCRYPTION_SECRET: Buffer.alloc(32, 7).toString("base64"),
  DEFAULT_PROVIDER: "anthropic",
  DEFAULT_MODEL: "fake-model",
  PLATFORM_API_KEY: "test-platform-key",
  PLATFORM_MONTHLY_RECEIPT_LIMIT: "100",
  MAX_UPLOAD_BYTES: "10485760",
  INNGEST_EVENT_KEY: "test-inngest-event-key",
  INNGEST_SIGNING_KEY: "test-inngest-signing-key",
  CRON_SECRET: "test-cron-secret-0123456789",
};

export const testEnv = (overrides: Record<string, string> = {}): Env =>
  parseEnv({ ...TEST_ENV_SOURCE, ...overrides });

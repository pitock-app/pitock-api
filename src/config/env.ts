import { z } from "zod";

// Variabili vuote nel file .env (es. `SUPABASE_URL=`) valgono come assenti.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess((v) => (v === "" || v === undefined ? fallback : v), schema);

const base64Key32 = z.string().refine((v) => Buffer.from(v, "base64").length === 32, {
  message: "deve essere di 32 byte codificati in base64 (openssl rand -base64 32)",
});

export const PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];

const BaseEnvSchema = z.object({
  NODE_ENV: withDefault(z.enum(["development", "test", "production"]), "development"),
  APP_VERSION: withDefault(z.string().min(1), "0.1.0"),
  ALLOWED_ORIGINS: withDefault(z.string(), "http://localhost:3000").transform((v) =>
    v
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
  ),
  ALLOWED_ORIGIN_REGEX: optional(
    z.string().refine(
      (v) => {
        try {
          new RegExp(v);
          return true;
        } catch {
          return false;
        }
      },
      { message: "non è una regex valida" },
    ),
  ),
  SUPABASE_URL: optional(z.url()),
  SUPABASE_SERVICE_ROLE_KEY: optional(z.string().min(1)),
  SUPABASE_JWKS_URL: optional(z.url()),
  SUPABASE_JWT_ISSUER: optional(z.url()),
  DATABASE_URL: optional(z.string().min(1)),
  KEY_ENCRYPTION_SECRET: optional(base64Key32),
  DEFAULT_PROVIDER: withDefault(z.enum(PROVIDERS), "anthropic"),
  DEFAULT_MODEL: optional(z.string().min(1)),
  PLATFORM_API_KEY: optional(z.string().min(1)),
  PLATFORM_MONTHLY_RECEIPT_LIMIT: withDefault(z.coerce.number().int().nonnegative(), 100),
  MAX_UPLOAD_BYTES: withDefault(z.coerce.number().int().positive(), 10_485_760),
  INNGEST_EVENT_KEY: optional(z.string().min(1)),
  INNGEST_SIGNING_KEY: optional(z.string().min(1)),
  /** Solo in locale con `pnpm inngest:dev`: disattiva la verifica della firma. Ignorata in produzione. */
  INNGEST_DEV: withDefault(z.enum(["0", "1"]), "0").transform((v) => v === "1"),
  CRON_SECRET: optional(z.string().min(16)),
});

/** Variabili facoltative in sviluppo e test, ma obbligatorie in produzione. */
export const REQUIRED_IN_PRODUCTION = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWKS_URL",
  "SUPABASE_JWT_ISSUER",
  "DATABASE_URL",
  "KEY_ENCRYPTION_SECRET",
  "DEFAULT_MODEL",
  "PLATFORM_API_KEY",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "CRON_SECRET",
] as const;

export const EnvSchema = BaseEnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== "production") return;
  for (const key of REQUIRED_IN_PRODUCTION) {
    if (env[key] === undefined) {
      ctx.addIssue({ code: "custom", path: [key], message: "obbligatoria in produzione" });
    }
  }
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvError extends Error {
  override readonly name = "EnvError";
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new EnvError(`Variabili d'ambiente non valide:\n${lines.join("\n")}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Legge e valida `process.env` una sola volta. Lancia `EnvError` con un messaggio chiaro. */
export function loadEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

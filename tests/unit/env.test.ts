import { describe, expect, it } from "vitest";
import { EnvError, REQUIRED_IN_PRODUCTION, parseEnv } from "../../src/config/env.js";
import { TEST_ENV_SOURCE, testEnv } from "../helpers/test-env.js";

describe("env", () => {
  it("parte senza DATABASE_URL né segreti, con i default", () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe("development");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ALLOWED_ORIGINS).toEqual(["http://localhost:3000"]);
    expect(env.PLATFORM_MONTHLY_RECEIPT_LIMIT).toBe(100);
    expect(env.MAX_UPLOAD_BYTES).toBe(10_485_760);
    expect(env.DEFAULT_PROVIDER).toBe("anthropic");
  });

  it("tratta le variabili vuote come assenti", () => {
    const env = parseEnv({ DATABASE_URL: "", MAX_UPLOAD_BYTES: "", SUPABASE_URL: "" });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SUPABASE_URL).toBeUndefined();
    expect(env.MAX_UPLOAD_BYTES).toBe(10_485_760);
  });

  it("separa ALLOWED_ORIGINS per virgola", () => {
    const env = parseEnv({ ALLOWED_ORIGINS: "http://a.test, https://b.test ," });
    expect(env.ALLOWED_ORIGINS).toEqual(["http://a.test", "https://b.test"]);
  });

  it("fallisce con un messaggio chiaro su valori non validi", () => {
    expect(() =>
      parseEnv({ KEY_ENCRYPTION_SECRET: "corta", MAX_UPLOAD_BYTES: "abc", DEFAULT_PROVIDER: "x" }),
    ).toThrow(EnvError);
    const message = (() => {
      try {
        parseEnv({ KEY_ENCRYPTION_SECRET: "corta" });
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(message).toMatch(/KEY_ENCRYPTION_SECRET/);
    expect(message).not.toMatch(/corta/);
  });

  it("rifiuta una ALLOWED_ORIGIN_REGEX non valida", () => {
    expect(() => parseEnv({ ALLOWED_ORIGIN_REGEX: "([" })).toThrow(/ALLOWED_ORIGIN_REGEX/);
  });

  it("testEnv fornisce valori fittizi validi", () => {
    const env = testEnv();
    expect(env.NODE_ENV).toBe("test");
    expect(env.KEY_ENCRYPTION_SECRET).toBeDefined();
    expect(testEnv({ APP_VERSION: "9.9.9" }).APP_VERSION).toBe("9.9.9");
  });

  it("in produzione richiede tutti i segreti", () => {
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/CRON_SECRET/);
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/obbligatoria in produzione/);
    for (const key of REQUIRED_IN_PRODUCTION) {
      expect(() => parseEnv({ ...TEST_ENV_SOURCE, NODE_ENV: "production", [key]: "" })).toThrow(
        key,
      );
    }
    expect(parseEnv({ ...TEST_ENV_SOURCE, NODE_ENV: "production" }).NODE_ENV).toBe("production");
  });
});

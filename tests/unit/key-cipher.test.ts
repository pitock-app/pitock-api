import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KeyCipherError,
  apiKeyContext,
  createKeyCipher,
  keyCipherFromSecret,
  last4,
} from "../../src/infra/crypto/key-cipher.js";

const secretV1 = randomBytes(32).toString("base64");
const secretV2 = randomBytes(32).toString("base64");
const context = apiKeyContext("user-1", "anthropic");
const apiKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-1234";

const flipFirstByte = (base64: string) => {
  const buf = Buffer.from(base64, "base64");
  buf[0] = (buf[0] ?? 0) ^ 0xff;
  return buf.toString("base64");
};

describe("key-cipher", () => {
  const cipher = keyCipherFromSecret(secretV1);

  it("encrypt → decrypt restituisce l'originale", () => {
    const secret = cipher.encrypt(apiKey, context);
    expect(secret.keyVersion).toBe(1);
    expect(cipher.decrypt(secret, context)).toBe(apiKey);
  });

  it("il ciphertext non contiene la chiave in chiaro", () => {
    const secret = cipher.encrypt(apiKey, context);
    expect(JSON.stringify(secret)).not.toContain(apiKey);
    expect(Buffer.from(secret.ciphertext, "base64").toString("utf8")).not.toContain("sk-ant");
  });

  it("usa un IV casuale di 12 byte diverso a ogni cifratura", () => {
    const a = cipher.encrypt(apiKey, context);
    const b = cipher.encrypt(apiKey, context);
    expect(Buffer.from(a.iv, "base64")).toHaveLength(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it.each(["ciphertext", "iv", "authTag"] as const)("%s manomesso → errore", (field) => {
    const secret = cipher.encrypt(apiKey, context);
    const tampered = { ...secret, [field]: flipFirstByte(secret[field]) };
    expect(() => cipher.decrypt(tampered, context)).toThrow(KeyCipherError);
  });

  it("contesto diverso (altra riga) → errore", () => {
    const secret = cipher.encrypt(apiKey, context);
    expect(() => cipher.decrypt(secret, "user-2:anthropic")).toThrow(KeyCipherError);
  });

  it("chiave master diversa → errore", () => {
    const secret = cipher.encrypt(apiKey, context);
    const other = keyCipherFromSecret(secretV2);
    expect(() => other.decrypt(secret, context)).toThrow(KeyCipherError);
  });

  it("rotazione: decifra con la versione salvata, cifra con quella corrente", () => {
    const old = cipher.encrypt(apiKey, context);
    const rotated = createKeyCipher({ keys: { 1: secretV1, 2: secretV2 }, currentVersion: 2 });
    expect(rotated.decrypt(old, context)).toBe(apiKey);
    expect(rotated.encrypt(apiKey, context).keyVersion).toBe(2);
  });

  it("versione sconosciuta → errore", () => {
    const secret = { ...cipher.encrypt(apiKey, context), keyVersion: 9 };
    expect(() => cipher.decrypt(secret, context)).toThrow(KeyCipherError);
  });

  it("rifiuta una chiave master che non è di 32 byte", () => {
    expect(() => keyCipherFromSecret(randomBytes(16).toString("base64"))).toThrow(KeyCipherError);
  });

  it("gli errori non contengono la chiave", () => {
    const secret = cipher.encrypt(apiKey, context);
    try {
      cipher.decrypt({ ...secret, authTag: flipFirstByte(secret.authTag) }, context);
    } catch (err) {
      expect(String(err)).not.toContain(apiKey);
      expect(String(err)).not.toContain(secretV1);
    }
  });

  it("contesto vuoto → errore", () => {
    expect(() => cipher.encrypt(apiKey, "")).toThrow(KeyCipherError);
    const secret = cipher.encrypt(apiKey, context);
    expect(() => cipher.decrypt(secret, "")).toThrow(KeyCipherError);
  });

  it("last4 restituisce le ultime 4 cifre", () => {
    expect(last4(` ${apiKey} `)).toBe("1234");
  });

  it("last4 rifiuta chiavi troppo corte", () => {
    expect(() => last4("sk-1234")).toThrow(KeyCipherError);
  });
});

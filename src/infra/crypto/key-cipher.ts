import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Valori salvati in `user_api_keys` (base64). */
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export class KeyCipherError extends Error {
  override readonly name = "KeyCipherError";
}

export interface KeyCipher {
  readonly currentVersion: number;
  /** `context` (es. `userId:provider`) è legato al ciphertext come AAD: non si può spostare su un'altra riga. */
  encrypt(plaintext: string, context: string): EncryptedSecret;
  decrypt(secret: EncryptedSecret, context: string): string;
}

function assertContext(context: string): void {
  if (context.length === 0) {
    throw new KeyCipherError("Il contesto (AAD) non può essere vuoto");
  }
}

/** Contesto standard di una chiave BYOK: lega il ciphertext alla riga (utente, provider). */
export function apiKeyContext(userId: string, provider: string): string {
  return `${userId}:${provider}`;
}

function decodeKey(base64: string, version: number): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new KeyCipherError(`La chiave master v${version} deve essere di ${KEY_BYTES} byte`);
  }
  return key;
}

/**
 * AES-256-GCM con IV casuale di 12 byte per ogni cifratura.
 * `keys` mappa `key_version` → chiave master in base64; si cifra sempre con `currentVersion`,
 * si decifra con la versione salvata nella riga (rotazione della chiave master).
 */
export function createKeyCipher(options: {
  keys: Readonly<Record<number, string>>;
  currentVersion: number;
}): KeyCipher {
  const keys = new Map<number, Buffer>();
  for (const [version, base64] of Object.entries(options.keys)) {
    keys.set(Number(version), decodeKey(base64, Number(version)));
  }
  const { currentVersion } = options;
  const currentKey = keys.get(currentVersion);
  if (!currentKey) {
    throw new KeyCipherError(`Chiave master v${currentVersion} assente`);
  }

  return {
    currentVersion,

    encrypt(plaintext, context) {
      assertContext(context);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, currentKey, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        keyVersion: currentVersion,
      };
    },

    decrypt(secret, context) {
      assertContext(context);
      const key = keys.get(secret.keyVersion);
      if (!key) {
        throw new KeyCipherError(`Chiave master v${secret.keyVersion} assente`);
      }
      const iv = Buffer.from(secret.iv, "base64");
      const authTag = Buffer.from(secret.authTag, "base64");
      if (iv.length !== IV_BYTES || authTag.length !== TAG_BYTES) {
        throw new KeyCipherError("Segreto cifrato non valido");
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(authTag);
        return Buffer.concat([
          decipher.update(Buffer.from(secret.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Non propagare dettagli: un tag non valido significa dati manomessi o chiave errata.
        throw new KeyCipherError("Impossibile decifrare il segreto");
      }
    },
  };
}

/** Cifrario con la sola `KEY_ENCRYPTION_SECRET` come versione 1. */
export function keyCipherFromSecret(secretBase64: string): KeyCipher {
  return createKeyCipher({ keys: { 1: secretBase64 }, currentVersion: 1 });
}

/** Lunghezza minima di una chiave API: sotto questa soglia `last4` ne rivelerebbe troppo. */
export const MIN_API_KEY_LENGTH = 16;

/** Ultime 4 cifre da mostrare all'utente: l'unica parte della chiave che lascia il backend. */
export function last4(apiKey: string): string {
  const key = apiKey.trim();
  if (key.length < MIN_API_KEY_LENGTH) {
    throw new KeyCipherError("Chiave API troppo corta");
  }
  return key.slice(-4);
}

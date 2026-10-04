const MASK = "[REDACTED]";

/** Chiavi i cui valori non vanno mai registrati, a prescindere dal contenuto. */
const SECRET_KEYS =
  /^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|password|secret|ciphertext|auth[-_]?tag|iv)$/i;

/** Valori che somigliano a una chiave o a un token. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

export function redactString(value: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, MASK), value);
}

/** Copia profonda con i segreti mascherati. Usata dal logger su ogni record. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? MASK : redact(v, depth + 1);
  }
  return out;
}

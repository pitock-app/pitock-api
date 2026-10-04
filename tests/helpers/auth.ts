import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import {
  createJwtVerifier,
  SUPABASE_AUDIENCE,
  type TokenVerifier,
} from "../../src/middleware/auth.js";

export const TEST_ISSUER = "http://supabase.test/auth/v1";

export interface TestAuth {
  verifier: TokenVerifier;
  token: (
    userId: string,
    opts?: { email?: string; issuer?: string; audience?: string; expiresIn?: string },
  ) => Promise<string>;
  /** Token firmato con una chiave diversa da quella delle JWKS. */
  foreignToken: (userId: string) => Promise<string>;
}

/** Coppia di chiavi ES256 locale al posto delle JWKS di Supabase. */
export async function createTestAuth(): Promise<TestAuth> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const other = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test", alg: "ES256" };
  const verifier = createJwtVerifier({
    jwks: createLocalJWKSet({ keys: [jwk] }),
    issuer: TEST_ISSUER,
    audience: SUPABASE_AUDIENCE,
  });

  const sign = (key: CryptoKey, userId: string, o: Parameters<TestAuth["token"]>[1] = {}) =>
    new SignJWT({ email: o.email ?? `${userId.slice(0, 8)}@example.test`, role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setSubject(userId)
      .setIssuer(o.issuer ?? TEST_ISSUER)
      .setAudience(o.audience ?? SUPABASE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(o.expiresIn ?? "5m")
      .sign(key);

  return {
    verifier,
    token: (userId, o) => sign(privateKey, userId, o),
    foreignToken: (userId) => sign(other.privateKey, userId),
  };
}

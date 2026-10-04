import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { AppError } from "../shared/errors.js";
import type { AppEnv } from "../types.js";

export interface AuthUser {
  userId: string;
  email: string | null;
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthUser>;
}

export interface JwtVerifierOptions {
  jwks: JWTVerifyGetKey;
  issuer: string;
  audience: string;
}

/** Audience dei token di accesso di Supabase Auth. */
export const SUPABASE_AUDIENCE = "authenticated";

const Claims = z.object({ sub: z.uuid(), email: z.string().optional() });

export function createJwtVerifier(opts: JwtVerifierOptions): TokenVerifier {
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, opts.jwks, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ["RS256", "ES256"],
        });
        const claims = Claims.parse(payload);
        return { userId: claims.sub, email: claims.email ?? null };
      } catch (err) {
        if (err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid) {
          throw new AppError("SERVICE_UNAVAILABLE", "Verifica del token non disponibile");
        }
        throw new AppError("UNAUTHORIZED", "Token non valido o scaduto");
      }
    },
  };
}

export const remoteJwks = (url: string) => createRemoteJWKSet(new URL(url));

/** Richiede `Authorization: Bearer <access_token>` e mette `userId` ed `email` nel contesto. */
export const requireAuth = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) throw new AppError("UNAUTHORIZED", "Token mancante");
    const user = await c.get("container").auth.verify(match[1]);
    c.set("userId", user.userId);
    c.set("email", user.email);
    await next();
  });

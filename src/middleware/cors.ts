import { cors as honoCors } from "hono/cors";
import type { Env } from "../config/env.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

/** true se l'origine è in ALLOWED_ORIGINS o corrisponde ad ALLOWED_ORIGIN_REGEX. */
export function isAllowedOrigin(env: Env, origin: string): boolean {
  if (env.ALLOWED_ORIGINS.includes(origin)) return true;
  if (!env.ALLOWED_ORIGIN_REGEX) return false;
  return new RegExp(env.ALLOWED_ORIGIN_REGEX).test(origin);
}

/** Credenziali via header Authorization, mai cookie: `credentials` resta disattivato. */
export const cors = (env: Env) =>
  honoCors({
    origin: (origin) => (origin && isAllowedOrigin(env, origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", REQUEST_ID_HEADER],
    exposeHeaders: [REQUEST_ID_HEADER, "Retry-After"],
    maxAge: 600,
    credentials: false,
  });

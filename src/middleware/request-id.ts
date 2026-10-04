import { randomUUID } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types.js";

export const REQUEST_ID_HEADER = "X-Request-Id";
const VALID_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Riusa l'id del chiamante se ben formato, altrimenti ne genera uno. */
export const requestId = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
    c.set("requestId", id);
    c.header(REQUEST_ID_HEADER, id);
    await next();
  });

import type { Hono } from "hono";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { AppEnv } from "./types.js";

// Entry per Vercel: l'app Hono è l'export di default.
// L'import esplicito di "hono" serve al rilevamento automatico del framework su Vercel.
const app: Hono<AppEnv> = createApp(loadEnv());

export default app;

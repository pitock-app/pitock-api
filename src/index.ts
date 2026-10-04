import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";

// Entry per Vercel: l'app Hono è l'export di default.
const app = createApp(loadEnv());

export default app;

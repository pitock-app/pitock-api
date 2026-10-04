import { readFile, writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { parseEnv } from "../src/config/env.js";

// Il contratto non dipende dai segreti: env minimo, nessun servizio esterno contattato.
const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
const app = createApp(parseEnv({ NODE_ENV: "test", APP_VERSION: pkg.version }));
const res = await app.request("/openapi.json");
if (!res.ok) throw new Error(`/openapi.json ha risposto ${res.status}`);
const doc: unknown = await res.json();
await writeFile("openapi.json", `${JSON.stringify(doc, null, 2)}\n`);
console.log("openapi.json aggiornato");

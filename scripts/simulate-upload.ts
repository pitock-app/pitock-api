import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// Simula il frontend su un progetto reale: login Supabase, upload-url, upload diretto
// su Storage, complete, attesa dell'estrazione. Uso: pnpm simulate:upload <file|cartella...>

const Env = z.object({
  SIMULATE_API_URL: z.url().default("http://localhost:8787"),
  SIMULATE_EMAIL: z.email(),
  SIMULATE_PASSWORD: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
});

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

const POLL_MS = 2000;
const TIMEOUT_MS = 180_000;

const env = Env.safeParse(process.env);
if (!env.success) {
  const fields = env.error.issues.map((i) => i.path.join(".")).join(", ");
  console.error(`Variabili mancanti o non valide: ${fields}`);
  process.exit(1);
}
const { SIMULATE_API_URL, SIMULATE_EMAIL, SIMULATE_PASSWORD, SUPABASE_URL, SUPABASE_ANON_KEY } =
  env.data;

async function collect(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    if ((await stat(p)).isDirectory()) {
      const entries = (await readdir(p)).sort().map((f) => join(p, f));
      out.push(...(await collect(entries.filter((f) => extname(f).toLowerCase() in MIME_BY_EXT))));
    } else if (extname(p).toLowerCase() in MIME_BY_EXT) {
      out.push(p);
    }
  }
  return out;
}

const files = await collect(process.argv.slice(2));
if (files.length === 0) {
  console.error("Uso: pnpm simulate:upload <file|cartella...> (jpg, png, webp, pdf)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: auth, error: authError } = await supabase.auth.signInWithPassword({
  email: SIMULATE_EMAIL,
  password: SIMULATE_PASSWORD,
});
if (authError) {
  console.error("Login fallito:", authError.message);
  process.exit(1);
}
const token = auth.session.access_token;

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${SIMULATE_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json: unknown = res.status === 204 ? null : await res.json();
  return { status: res.status, json };
};

const UploadUrl = z.object({ receiptId: z.uuid(), path: z.string(), token: z.string() });
const Detail = z.object({
  receipt: z.object({ status: z.string(), errorCode: z.string().nullable() }),
  extraction: z
    .object({
      merchantName: z.string().nullable(),
      total: z.number().nullable(),
      currency: z.string(),
    })
    .optional(),
  usage: z
    .object({ provider: z.string(), model: z.string(), totalTokens: z.number().nullable() })
    .optional(),
});

let failures = 0;
for (const file of files) {
  const bytes = await readFile(file);
  const mimeType = MIME_BY_EXT[extname(file).toLowerCase()] ?? "application/octet-stream";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  console.log(`\n${basename(file)} (${bytes.length} byte)`);

  const up = await api("POST", "/v1/receipts/upload-url", {
    source: "file",
    sha256,
    mimeType,
    sizeBytes: bytes.length,
    originalFilename: basename(file),
  });
  if (up.status === 409) {
    console.log("  già caricato:", JSON.stringify(up.json));
    continue;
  }
  const signed = UploadUrl.safeParse(up.json);
  if (up.status !== 201 || !signed.success) {
    console.log(`  upload-url → ${up.status}`, JSON.stringify(up.json));
    failures++;
    continue;
  }
  const { receiptId, path, token: uploadToken } = signed.data;

  const { error: upErr } = await supabase.storage
    .from("receipts")
    .uploadToSignedUrl(path, uploadToken, bytes, { contentType: mimeType });
  if (upErr) {
    console.log("  upload su Storage fallito:", upErr.message);
    failures++;
    continue;
  }

  const done = await api("POST", `/v1/receipts/${receiptId}/complete`);
  if (done.status !== 202) {
    console.log(`  complete → ${done.status}`, JSON.stringify(done.json));
    failures++;
    continue;
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let detail: z.infer<typeof Detail> | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const d = Detail.safeParse((await api("GET", `/v1/receipts/${receiptId}`)).json);
    if (d.success && ["extracted", "failed"].includes(d.data.receipt.status)) {
      detail = d.data;
      break;
    }
  }
  if (!detail) {
    console.log("  timeout: l'estrazione non è terminata (Inngest è attivo?)");
    failures++;
  } else if (detail.receipt.status === "failed") {
    console.log(`  failed: ${detail.receipt.errorCode ?? "?"}`);
    failures++;
  } else {
    const e = detail.extraction;
    console.log(`  esercente: ${e?.merchantName ?? "-"}`);
    console.log(`  totale:    ${e?.total ?? "-"} ${e?.currency ?? ""}`);
    console.log(
      `  modello:   ${detail.usage ? `${detail.usage.provider}/${detail.usage.model}` : "-"}`,
    );
    console.log(`  token:     ${detail.usage?.totalTokens ?? "-"}`);
  }
}

console.log(`\n${files.length - failures}/${files.length} scontrini estratti.`);
process.exit(failures > 0 ? 1 : 0);

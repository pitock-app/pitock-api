import type { Clock } from "../../src/ports/clock.port.js";
import type {
  LlmError,
  LlmPingRequest,
  LlmPort,
  LlmRequest,
  LlmResult,
} from "../../src/ports/llm.port.js";
import type { CatalogModel, ModelCatalogPort } from "../../src/ports/model-catalog.port.js";
import type { Provider } from "../../src/config/env.js";
import type { QueueEventName, QueueEvents, QueuePort } from "../../src/ports/queue.port.js";
import type { StoragePort } from "../../src/ports/storage.port.js";
import type { UserAdminPort } from "../../src/ports/user-admin.port.js";

interface StoredObject {
  bytes: Uint8Array;
  mimeType: string;
}

/** Storage in memoria: simula il bucket privato e gli URL firmati. */
export class FakeStorage implements StoragePort {
  readonly objects = new Map<string, StoredObject>();
  readonly uploadUrls: string[] = [];

  createSignedUploadUrl(path: string) {
    const uploadUrl = `https://storage.test/upload/${path}?token=tok`;
    this.uploadUrls.push(path);
    return Promise.resolve({ uploadUrl, token: "tok", path });
  }

  createSignedReadUrl(path: string, expiresIn: number) {
    return Promise.resolve(`https://storage.test/read/${path}?exp=${expiresIn}`);
  }

  stat(path: string) {
    const o = this.objects.get(path);
    return Promise.resolve(o ? { sizeBytes: o.bytes.length, mimeType: o.mimeType } : null);
  }

  readHead(path: string, length: number) {
    return Promise.resolve(this.objects.get(path)?.bytes.slice(0, length) ?? new Uint8Array());
  }

  download(path: string) {
    const o = this.objects.get(path);
    return o ? Promise.resolve(o.bytes) : Promise.reject(new Error("oggetto assente"));
  }

  remove(paths: string[]) {
    for (const p of paths) this.objects.delete(p);
    return Promise.resolve();
  }

  removeFolder(folder: string) {
    for (const p of [...this.objects.keys()])
      if (p.startsWith(`${folder}/`)) this.objects.delete(p);
    return Promise.resolve();
  }

  /** Simula l'upload diretto del frontend su Storage. */
  put(path: string, bytes: Uint8Array, mimeType: string) {
    this.objects.set(path, { bytes, mimeType });
  }
}

export interface SentEvent<N extends QueueEventName = QueueEventName> {
  name: N;
  data: QueueEvents[N];
}

export class FakeQueue implements QueuePort {
  readonly events: SentEvent[] = [];

  send<N extends QueueEventName>(name: N, data: QueueEvents[N]) {
    this.events.push({ name, data });
    return Promise.resolve();
  }

  clear() {
    this.events.length = 0;
  }
}

/** Orologio controllabile: ogni lettura avanza di 1 ms, così l'ordine di creazione è stabile. */
export class FakeClock implements Clock {
  constructor(private t = new Date("2026-10-04T10:00:00.000Z").getTime()) {}

  now() {
    this.t += 1;
    return new Date(this.t);
  }

  set(iso: string) {
    this.t = new Date(iso).getTime();
  }
}

/** File fittizi con magic bytes reali. */
export const JPEG = (size = 1024) => {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};

export const PDF = (size = 1024) => {
  const b = new Uint8Array(size);
  b.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  return b;
};

type LlmStep = LlmResult | LlmError | ((req: LlmRequest) => LlmResult | LlmError);

/** Modello finto: risponde con i passi accodati, in ordine; registra ogni richiesta. */
export class FakeLlm implements LlmPort {
  readonly requests: LlmRequest[] = [];
  readonly pings: LlmPingRequest[] = [];
  private steps: LlmStep[] = [];

  /** Accoda le risposte delle prossime chiamate (un `LlmError` viene lanciato). */
  respond(...steps: LlmStep[]) {
    this.steps.push(...steps);
    return this;
  }

  reset() {
    this.steps = [];
    this.requests.length = 0;
    this.pings.length = 0;
  }

  /** Usa la stessa coda di `generateStructured`: un `LlmError` accodato viene lanciato. */
  ping(req: LlmPingRequest) {
    this.pings.push(req);
    const step = this.steps.shift();
    if (!step) return Promise.reject(new Error("FakeLlm: nessuna risposta accodata"));
    if (typeof step === "function") return Promise.reject(new Error("FakeLlm: passo non valido"));
    return step instanceof Error ? Promise.reject(step) : Promise.resolve({ usage: step.usage });
  }

  generateStructured(req: LlmRequest) {
    this.requests.push(req);
    const step = this.steps.shift();
    if (!step) return Promise.reject(new Error("FakeLlm: nessuna risposta accodata"));
    const res = typeof step === "function" ? step(req) : step;
    return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
  }
}

export const usage = (input = 1000, output = 200) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
});

/** Output valido del modello per uno scontrino da 12,30 €. */
export const validOutput = (o: Record<string, unknown> = {}) => ({
  is_receipt: true,
  merchant_name: "Supermercato Rossi",
  merchant_vat: "01234567890",
  merchant_address: "Via Roma 1, Torino",
  purchased_at: "2026-10-03T18:30:00",
  currency: "EUR",
  total: 12.3,
  tax_total: 1.1,
  payment_method: "carta",
  category: "alimentari",
  items: [
    { description: "Pane", quantity: 1, unit_price: 2.3, amount: 2.3, vat_rate: 4, category: null },
    { description: "Vino", quantity: 1, unit_price: 10, amount: 10, vat_rate: 22, category: null },
  ],
  confidence: 0.92,
  notes: null,
  ...o,
});

/** Catalogo finto: chiavi valide e modelli configurabili per provider; registra le chiamate. */
export class FakeCatalog implements ModelCatalogPort {
  readonly verified: { provider: Provider; apiKey: string }[] = [];
  readonly listed: { provider: Provider; apiKey: string | null }[] = [];
  /** Chiavi che il provider rifiuta, con il tipo di errore. */
  readonly rejected = new Map<string, LlmError>();
  models: CatalogModel[] = [
    { id: "model-a", label: "Model A", supportsImages: true, supportsPdf: true },
    { id: "model-b", label: "Model B", supportsImages: true, supportsPdf: false },
  ];

  verifyKey(provider: Provider, apiKey: string) {
    this.verified.push({ provider, apiKey });
    const err = this.rejected.get(apiKey);
    return err ? Promise.reject(err) : Promise.resolve();
  }

  listModels(provider: Provider, apiKey: string | null) {
    this.listed.push({ provider, apiKey });
    const err = apiKey ? this.rejected.get(apiKey) : undefined;
    return err ? Promise.reject(err) : Promise.resolve(this.models);
  }
}

/** Supabase Auth Admin finto: cancella l'utente dallo stub `auth.users`; registra le chiamate. */
export class FakeUserAdmin implements UserAdminPort {
  readonly deleted: string[] = [];
  fail = false;

  constructor(private readonly exec: (text: string) => Promise<void>) {}

  async deleteUser(userId: string) {
    if (this.fail) throw new Error("auth: deleteUser fallita");
    this.deleted.push(userId);
    if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error("userId non valido");
    await this.exec(`delete from auth.users where id = '${userId}'`);
  }
}

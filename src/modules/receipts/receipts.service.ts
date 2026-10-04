import { randomUUID } from "node:crypto";
import type { Provider } from "../../config/env.js";
import { isUniqueViolation } from "../../infra/db/errors.js";
import type { Clock } from "../../ports/clock.port.js";
import type { QueuePort } from "../../ports/queue.port.js";
import type { StoragePort } from "../../ports/storage.port.js";
import { parseIsoInTimeZone } from "../../shared/dates.js";
import { AppError, notFound } from "../../shared/errors.js";
import {
  EXTENSION_BY_MIME,
  SNIFF_BYTES,
  sniffMimeType,
  type MimeType,
} from "../../shared/files.js";
import { decodeCursor, toPage } from "../../shared/pagination.js";
import type { UsageRepo } from "../usage/usage.repo.js";
import type { ExtractionsRepo } from "../extraction/extractions.repo.js";
import { toExtraction, toReceipt, asCategory } from "./receipts.mappers.js";
import type { ReceiptListFilters, ReceiptsRepo } from "./receipts.repo.js";
import type { ManualReceiptInput, ReceiptListQuery } from "./receipts.schemas.js";

/** Validità degli URL firmati (sezione 9). */
export const UPLOAD_URL_TTL_SECONDS = 120;
export const READ_URL_TTL_SECONDS = 600;

export interface ReceiptsDeps {
  receipts: ReceiptsRepo;
  extractions: ExtractionsRepo;
  usage: UsageRepo;
  storage: StoragePort;
  queue: QueuePort;
  clock: Clock;
  maxUploadBytes: number;
}

export interface UploadRequest {
  source: "camera" | "file";
  sha256: string;
  mimeType: MimeType;
  sizeBytes: number;
  capturedAt?: string | undefined;
  originalFilename?: string | undefined;
}

const toDate = (v: string) => {
  const d = parseIsoInTimeZone(v);
  if (!d) throw new AppError("VALIDATION_ERROR", "Data non valida");
  return d;
};

const duplicate = (id: string) =>
  new AppError("DUPLICATE", "Scontrino già caricato", { duplicateOf: id });

export function createReceiptsService(d: ReceiptsDeps) {
  const requireReceipt = async (userId: string, id: string) => {
    const r = await d.receipts.findById(userId, id);
    if (!r) throw notFound("Scontrino");
    return r;
  };

  const detail = async (userId: string, id: string) => {
    const receipt = await requireReceipt(userId, id);
    const extraction = await d.extractions.findCurrent(userId, id);
    const usage = extraction ? await d.usage.findForExtraction(userId, extraction.id) : undefined;
    const fileUrl =
      receipt.storagePath && receipt.status !== "pending_upload"
        ? await d.storage.createSignedReadUrl(receipt.storagePath, READ_URL_TTL_SECONDS)
        : undefined;
    const dto = extraction ? toExtraction(extraction) : undefined;
    return {
      receipt: toReceipt(receipt),
      ...(fileUrl ? { fileUrl } : {}),
      ...(dto ? { extraction: dto } : {}),
      items: dto?.items ?? [],
      ...(usage ? { usage } : {}),
    };
  };

  return {
    detail,

    async createUploadUrl(userId: string, req: UploadRequest) {
      if (req.sizeBytes > d.maxUploadBytes) {
        throw new AppError("FILE_TOO_LARGE", `Il file supera ${d.maxUploadBytes} byte`);
      }
      const existing = await d.receipts.findBySha256(userId, req.sha256);
      if (existing) {
        // Un caricamento mai completato non è un duplicato: si ricomincia da capo.
        if (existing.status !== "pending_upload") throw duplicate(existing.id);
        if (existing.storagePath) await d.storage.remove([existing.storagePath]);
        await d.receipts.delete(userId, existing.id);
      }

      const id = randomUUID();
      const path = `${userId}/${id}.${EXTENSION_BY_MIME[req.mimeType]}`;
      const now = d.clock.now();
      try {
        await d.receipts.insert(userId, now, {
          id,
          source: req.source,
          storagePath: path,
          originalFilename: req.originalFilename ?? null,
          sha256: req.sha256,
          mimeType: req.mimeType,
          sizeBytes: req.sizeBytes,
          capturedAt: req.capturedAt ? toDate(req.capturedAt) : null,
          status: "pending_upload",
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const winner = await d.receipts.findBySha256(userId, req.sha256);
        throw duplicate(winner?.id ?? id);
      }

      const signed = await d.storage.createSignedUploadUrl(path);
      return {
        receiptId: id,
        path: signed.path,
        uploadUrl: signed.uploadUrl,
        token: signed.token,
        expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      };
    },

    /** Ricontrolla l'oggetto realmente caricato, poi accoda l'estrazione. */
    async complete(userId: string, id: string) {
      const r = await requireReceipt(userId, id);
      if (r.source === "manual" || !r.storagePath) {
        throw new AppError("INVALID_STATE", "Lo scontrino non ha un file da caricare");
      }
      if (r.status !== "pending_upload") {
        throw new AppError("INVALID_STATE", `Lo scontrino è già nello stato ${r.status}`);
      }

      const info = await d.storage.stat(r.storagePath);
      if (!info) throw new AppError("UPLOAD_MISSING", "Il file non è stato caricato");

      const realType = sniffMimeType(await d.storage.readHead(r.storagePath, SNIFF_BYTES));
      const problem =
        info.sizeBytes > d.maxUploadBytes
          ? "dimensione oltre il massimo"
          : info.sizeBytes !== r.sizeBytes
            ? "dimensione diversa da quella dichiarata"
            : realType !== r.mimeType
              ? "tipo diverso da quello dichiarato"
              : null;
      if (problem) {
        // File e riga spariscono: il client può ricaricare lo stesso sha256 senza 409.
        await d.storage.remove([r.storagePath]);
        await d.receipts.delete(userId, id);
        throw new AppError("UPLOAD_MISMATCH", `File non valido: ${problem}`);
      }

      const updated = await d.receipts.update(userId, id, { status: "uploaded" }, [
        "pending_upload",
      ]);
      if (!updated) throw new AppError("INVALID_STATE", "Lo scontrino è già stato completato");
      await d.queue.send("receipt/uploaded", { receiptId: id, userId });
      return { status: "uploaded" as const };
    },

    async createManual(userId: string, input: ManualReceiptInput) {
      const { receipt } = await d.extractions.createManualReceipt(userId, {
        createdAt: d.clock.now(),
        rawJson: input,
        fields: {
          merchantName: input.merchantName,
          merchantVat: input.merchantVat ?? null,
          purchasedAt: toDate(input.purchasedAt),
          currency: input.currency ?? "EUR",
          total: input.total,
          taxTotal: input.taxTotal ?? null,
          paymentMethod: input.paymentMethod,
          category: input.category,
          notes: input.notes ?? null,
        },
        items: (input.items ?? []).map((i) => ({
          description: i.description,
          quantity: i.quantity ?? null,
          unitPrice: i.unitPrice ?? null,
          amount: i.amount ?? null,
          vatRate: i.vatRate ?? null,
          category: i.category ?? null,
        })),
      });
      await d.queue.send("stats/recompute", { userId });
      return detail(userId, receipt.id);
    },

    async list(userId: string, q: ReceiptListQuery) {
      const filters: ReceiptListFilters = {
        ...(q.status ? { status: q.status } : {}),
        ...(q.source ? { source: q.source } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(q.q ? { q: q.q } : {}),
        ...(q.from ? { from: toDate(q.from) } : {}),
      };
      if (q.to) {
        const at = toDate(q.to);
        // Con la sola data, `to` comprende l'intera giornata.
        filters.to = /^\d{4}-\d{2}-\d{2}$/.test(q.to)
          ? { at: new Date(at.getTime() + 86_400_000), exclusive: true }
          : { at, exclusive: false };
      }
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      const rows = await d.receipts.list(userId, filters, cursor, q.limit);
      const page = toPage(rows, q.limit);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((r) => ({
          id: r.id,
          source: r.source,
          status: r.status,
          merchantName: r.merchantName,
          purchasedAt: r.purchasedAt ? r.purchasedAt.toISOString() : null,
          total: r.total,
          currency: r.currency,
          category: asCategory(r.category),
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },

    async extractionHistory(userId: string, id: string) {
      await requireReceipt(userId, id);
      const rows = await d.extractions.listByReceipt(userId, id);
      return { items: rows.map(toExtraction) };
    },

    /** Rimette lo scontrino in coda; il job crea una nuova estrazione corrente (B3). */
    async reextract(userId: string, id: string, opts: { provider?: Provider; model?: string }) {
      const r = await requireReceipt(userId, id);
      if (r.source === "manual") {
        throw new AppError("INVALID_STATE", "Gli scontrini manuali non si rielaborano");
      }
      const updated = await d.receipts.update(userId, id, { status: "uploaded", errorCode: null }, [
        "extracted",
        "failed",
      ]);
      if (!updated) {
        throw new AppError("INVALID_STATE", `Lo scontrino è nello stato ${r.status}`);
      }
      const reextract = {
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      };
      await d.queue.send("receipt/uploaded", { receiptId: id, userId, reextract });
      return { status: "uploaded" as const };
    },

    /** Cancella prima il file (idempotente), poi le righe (estrazioni e righe a cascata). */
    async remove(userId: string, id: string) {
      const r = await requireReceipt(userId, id);
      if (r.storagePath) await d.storage.remove([r.storagePath]);
      await d.receipts.delete(userId, id);
      await d.queue.send("stats/recompute", { userId });
    },
  };
}

export type ReceiptsService = ReturnType<typeof createReceiptsService>;

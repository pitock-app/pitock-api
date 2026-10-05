import type { QueuePort } from "../../ports/queue.port.js";
import { parseIsoInTimeZone } from "../../shared/dates.js";
import { AppError, notFound } from "../../shared/errors.js";
import { toExtraction, toItemFields } from "../receipts/receipts.mappers.js";
import type { ExtractionPatch } from "../receipts/receipts.schemas.js";
import type { ExtractionFields, ExtractionsRepo } from "./extractions.repo.js";

export interface ExtractionEditDeps {
  extractions: ExtractionsRepo;
  queue: QueuePort;
}

/** Correzione manuale di un'estrazione (sezione 6.3). */
export function createExtractionEditService(d: ExtractionEditDeps) {
  return {
    async update(userId: string, id: string, patch: ExtractionPatch) {
      const current = await d.extractions.findById(userId, id);
      if (!current) throw notFound("Estrazione");
      if (!current.isCurrent) {
        throw new AppError("INVALID_STATE", "Si può modificare solo l'estrazione corrente");
      }

      const { items, purchasedAt, ...rest } = patch;
      const fields: ExtractionFields = { ...rest };
      if (purchasedAt !== undefined) {
        const parsed = purchasedAt === null ? null : parseIsoInTimeZone(purchasedAt);
        if (purchasedAt !== null && !parsed)
          throw new AppError("VALIDATION_ERROR", "Data non valida");
        fields.purchasedAt = parsed;
      }
      const newItems = items?.map(toItemFields);

      const updated = await d.extractions.update(userId, id, fields, newItems);
      if (!updated) throw notFound("Estrazione");
      await d.queue.send("stats/recompute", { userId });
      return toExtraction(updated);
    },
  };
}

export type ExtractionEditService = ReturnType<typeof createExtractionEditService>;

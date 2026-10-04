import { z } from "zod";
import { PROVIDERS } from "../config/env.js";
import type {
  ExtractionOutcome,
  ExtractionService,
} from "../modules/extraction/extraction.service.js";

/** Payload di `receipt/uploaded`: arriva da Inngest, quindi passa da Zod. */
export const ReceiptUploadedEvent = z.object({
  receiptId: z.uuid(),
  userId: z.uuid(),
  reextract: z
    .object({
      provider: z.enum(PROVIDERS).optional(),
      model: z.string().min(1).max(200).optional(),
    })
    .optional(),
});

export function extractReceiptJob(extraction: ExtractionService) {
  return async (data: unknown): Promise<ExtractionOutcome> => {
    const parsed = ReceiptUploadedEvent.safeParse(data);
    if (!parsed.success) return { status: "skipped", reason: "evento non valido" };
    const { receiptId, userId, reextract } = parsed.data;
    return extraction.process({
      receiptId,
      userId,
      ...(reextract
        ? {
            reextract: {
              ...(reextract.provider ? { provider: reextract.provider } : {}),
              ...(reextract.model ? { model: reextract.model } : {}),
            },
          }
        : {}),
    });
  };
}

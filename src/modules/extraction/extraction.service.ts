import { LlmError, type LlmPort, type LlmUsage } from "../../ports/llm.port.js";
import type { Clock } from "../../ports/clock.port.js";
import type { QueueEvents, QueuePort } from "../../ports/queue.port.js";
import type { StoragePort } from "../../ports/storage.port.js";
import type { MimeType } from "../../shared/files.js";
import type { AiConfig, AiRouter } from "../ai/ai-router.js";
import type { ReceiptsRepo } from "../receipts/receipts.repo.js";
import { costUsd, type ModelPrice } from "../usage/pricing.js";
import type { NewLlmUsage, UsageRepo } from "../usage/usage.repo.js";
import { ExtractionFailure, type ExtractionErrorCode } from "./extraction-errors.js";
import { ReceiptExtraction } from "./extraction.schema.js";
import type { ExtractionsRepo } from "./extractions.repo.js";
import { postprocess } from "./postprocess.js";
import { EXTRACTION_INSTRUCTIONS, EXTRACTION_PROMPT, PROMPT_VERSION } from "./prompts.js";

/** Tentativi per l'output non valido: la prima chiamata più un retry (sezione 7). */
export const MAX_ATTEMPTS = 2;

export interface ExtractionDeps {
  receipts: ReceiptsRepo;
  extractions: ExtractionsRepo;
  usage: UsageRepo;
  router: AiRouter;
  llm: LlmPort;
  storage: StoragePort;
  queue: QueuePort;
  clock: Clock;
}

export type ExtractionOutcome =
  | { status: "extracted"; extractionId: string }
  | { status: "failed"; errorCode: ExtractionErrorCode }
  | { status: "skipped"; reason: string };

interface Success {
  config: AiConfig;
  output: ReceiptExtraction;
  raw: unknown;
  callIndex: number;
}

const errorCodeFor = (e: LlmError, config: AiConfig): ExtractionErrorCode => {
  switch (e.kind) {
    case "invalid_output":
      return "INVALID_OUTPUT";
    case "unsupported_file":
      return "UNSUPPORTED_FILE_TYPE";
    case "auth":
      return config.keySource === "user" ? "USER_KEY_INVALID" : "LLM_UNAVAILABLE";
    case "quota":
      return config.keySource === "user" ? "USER_KEY_QUOTA" : "LLM_UNAVAILABLE";
    case "unavailable":
      return "LLM_UNAVAILABLE";
  }
};

/** Job `extract-receipt` (sezione 6.1, passo 5). */
export function createExtractionService(d: ExtractionDeps) {
  return {
    async process(event: QueueEvents["receipt/uploaded"]): Promise<ExtractionOutcome> {
      const { receiptId, userId, reextract } = event;
      const r = await d.receipts.findById(userId, receiptId);
      if (!r?.storagePath || !r.mimeType) return { status: "skipped", reason: "senza file" };
      // Transizione atomica: un evento duplicato o ritentato non rielabora lo stesso scontrino.
      const claimed = await d.receipts.update(
        userId,
        receiptId,
        { status: "processing", errorCode: null },
        ["uploaded"],
      );
      if (!claimed) return { status: "skipped", reason: `stato ${r.status}` };

      const storagePath = r.storagePath;
      const mimeType = r.mimeType as MimeType;
      const operation = reextract ? ("reextract" as const) : ("extract" as const);
      const calls: NewLlmUsage[] = [];
      const prices = new Map<string, ModelPrice | undefined>();

      const record = async (
        config: AiConfig,
        started: number,
        usage: LlmUsage | null,
        errorCode: ExtractionErrorCode | null,
      ) => {
        const key = `${config.provider}:${config.model}`;
        if (!prices.has(key))
          prices.set(key, await d.usage.findPrice(config.provider, config.model));
        const u = usage ?? { inputTokens: null, outputTokens: null, totalTokens: null };
        calls.push({
          receiptId,
          operation,
          provider: config.provider,
          model: config.model,
          keySource: config.keySource,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          totalTokens: u.totalTokens,
          costUsd: costUsd(prices.get(key), u.inputTokens, u.outputTokens),
          latencyMs: Math.max(0, d.clock.now().getTime() - started),
          success: errorCode === null,
          errorCode,
          createdAt: new Date(started),
        });
        return calls.length - 1;
      };

      /** Una chiamata più un retry se l'output non supera la validazione Zod. */
      const attempt = async (config: AiConfig, bytes: Uint8Array): Promise<Success> => {
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
          const started = d.clock.now().getTime();
          try {
            const res = await d.llm.generateStructured({
              provider: config.provider,
              model: config.model,
              apiKey: config.apiKey,
              instructions: EXTRACTION_INSTRUCTIONS,
              prompt: EXTRACTION_PROMPT,
              file: { bytes, mimeType },
              schema: ReceiptExtraction,
            });
            const parsed = ReceiptExtraction.safeParse(res.output);
            if (!parsed.success) {
              await record(config, started, res.usage, "INVALID_OUTPUT");
              continue;
            }
            const callIndex = await record(config, started, res.usage, null);
            return { config, output: parsed.data, raw: res.output, callIndex };
          } catch (err) {
            if (!(err instanceof LlmError)) throw err;
            await record(config, started, err.usage, errorCodeFor(err, config));
            if (err.kind !== "invalid_output") throw err;
          }
        }
        throw new ExtractionFailure(
          "INVALID_OUTPUT",
          "Output del modello non valido dopo il retry",
        );
      };

      const fail = async (code: ExtractionErrorCode): Promise<ExtractionOutcome> => {
        await d.usage.insertMany(userId, calls);
        await d.receipts.update(userId, receiptId, { status: "failed", errorCode: code });
        return { status: "failed", errorCode: code };
      };

      try {
        const plan = await d.router.resolveAiConfig(userId, reextract);
        let bytes: Uint8Array;
        try {
          bytes = await d.storage.download(storagePath);
        } catch {
          throw new ExtractionFailure("FILE_UNAVAILABLE", "File non leggibile dallo storage");
        }

        let success: Success;
        try {
          success = await attempt(plan.primary, bytes);
        } catch (err) {
          const keyProblem =
            err instanceof LlmError && (err.kind === "auth" || err.kind === "quota");
          if (!(keyProblem && plan.primary.keySource === "user")) throw err;
          if (!plan.fallbackToPlatform)
            throw new ExtractionFailure(errorCodeFor(err, plan.primary), err.message);
          success = await attempt(await d.router.platform(userId), bytes);
        }

        const pp = postprocess(success.output);
        if (!pp.isReceipt) return await fail("NOT_A_RECEIPT");

        const extraction = await d.extractions.saveLlmExtraction(userId, {
          receiptId,
          provider: success.config.provider,
          model: success.config.model,
          keySource: success.config.keySource,
          promptVersion: PROMPT_VERSION,
          rawJson: success.raw,
          confidence: pp.confidence,
          fields: pp.fields,
          items: pp.items,
          usage: calls,
          successfulCall: success.callIndex,
        });
        await d.queue.send("stats/recompute", { userId });
        return { status: "extracted", extractionId: extraction.id };
      } catch (err) {
        if (err instanceof ExtractionFailure) return fail(err.code);
        if (err instanceof LlmError) {
          const last = calls.at(-1)?.errorCode as ExtractionErrorCode | null | undefined;
          return fail(last ?? "LLM_UNAVAILABLE");
        }
        // Errore inatteso (DB, rete): lo scontrino non resta in `processing`.
        await fail("INTERNAL");
        throw err;
      }
    },
  };
}

export type ExtractionService = ReturnType<typeof createExtractionService>;

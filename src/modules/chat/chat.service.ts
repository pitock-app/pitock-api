import type { Clock } from "../../ports/clock.port.js";
import { LlmError, type LlmChatMessage, type LlmUsage } from "../../ports/llm.port.js";
import type { LlmPort } from "../../ports/llm.port.js";
import { DEFAULT_TIME_ZONE } from "../../shared/dates.js";
import { AppError } from "../../shared/errors.js";
import type { AiConfig, AiRouter } from "../ai/ai-router.js";
import { ExtractionFailure } from "../extraction/extraction-errors.js";
import type { StatsRepo } from "../stats/stats.repo.js";
import { costUsd } from "../usage/pricing.js";
import type { UsageRepo } from "../usage/usage.repo.js";
import { createChatTools, type ChatChart } from "./chat.tools.js";
import { ungroundedNumbers } from "./grounding.js";

export interface ChatDeps {
  stats: StatsRepo;
  router: AiRouter;
  usage: UsageRepo;
  llm: LlmPort;
  clock: Clock;
}

const MAX_STEPS = 6;
const MAX_CHARTS = 3;
const TIMEOUT_MS = 45_000;

export const UNVERIFIED_ANSWER =
  "Non riesco a darti una risposta verificata sui tuoi scontrini. Prova a riformulare la domanda.";

const today = (now: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TIME_ZONE, dateStyle: "short" }).format(now);

const instructions = (
  now: Date,
) => `Sei l'assistente di Pitock e rispondi a domande sulle spese dell'utente, ricavate dai suoi scontrini.
Oggi è ${today(now)} (fuso Europe/Rome). "Questo mese" va dal primo del mese a oggi.

Regole:
- Ogni numero che scrivi (importi, conteggi, percentuali) deve venire da un risultato degli strumenti. Non fare calcoli tu: se ti serve un totale, una somma o un confronto, chiama di nuovo spending con i filtri giusti.
- Se gli strumenti non restituiscono dati, dillo chiaramente. Non stimare e non inventare.
- Per un tipo di prodotto che non è una categoria (es. carne, latticini, caffè): chiama list_products sul periodo, scegli i nomi che corrispondono, poi chiama spending con products. Nella risposta elenca brevemente quali prodotti hai incluso.
- Grafici: chiedi chart in spending solo se aiuta davvero, cioè se confronti più gruppi o mostri un andamento nel tempo. Per un singolo totale usa chart "none".
- Rispondi in italiano, in modo breve. Importi come 12,50 €.
- Rispondi solo su spese e scontrini; per altro, spiega che non puoi aiutare.`;

/** `bad` null = risposta vuota (passi finiti senza testo). */
const regenerate = (bad: string[] | null): LlmChatMessage => ({
  role: "user",
  content: bad
    ? `Nella risposta ci sono numeri che non compaiono nei dati: ${bad.join(", ")}. Riscrivila usando solo numeri restituiti dagli strumenti; se ti serve un calcolo, chiama spending.`
    : "Non hai risposto. Rispondi ora alla domanda con i dati che hai già ottenuto dagli strumenti.",
});

/** Errore dell'AI router o del provider → errore HTTP pubblico. */
function toAppError(err: unknown, keySource: AiConfig["keySource"] | null): unknown {
  if (err instanceof ExtractionFailure) {
    if (err.code === "USER_KEY_MISSING" || err.code === "USER_KEY_INVALID")
      return new AppError(err.code, err.message);
    if (err.code === "PLATFORM_QUOTA_EXCEEDED") return new AppError(err.code, err.message);
    return new AppError("SERVICE_UNAVAILABLE", err.message);
  }
  if (err instanceof LlmError) {
    if (keySource === "user" && err.kind === "auth")
      return new AppError("USER_KEY_INVALID", err.message);
    if (keySource === "user" && err.kind === "quota")
      return new AppError("USER_KEY_QUOTA", err.message);
    return new AppError("PROVIDER_UNAVAILABLE", err.message);
  }
  return err;
}

/** Assistente sui dati di spesa: un agente con strumenti di sola lettura e il controllo dei numeri. */
export function createChatService(d: ChatDeps) {
  const record = async (
    userId: string,
    config: AiConfig,
    started: Date,
    usage: LlmUsage | null,
    errorCode: string | null,
  ) => {
    const u = usage ?? { inputTokens: null, outputTokens: null, totalTokens: null };
    const latencyMs = Math.max(0, d.clock.now().getTime() - started.getTime());
    // Best-effort: un errore del DB sul tracciamento non deve far perdere la risposta all'utente.
    try {
      const price = await d.usage.findPrice(config.provider, config.model);
      await d.usage.insertMany(userId, [
        {
          operation: "chat",
          provider: config.provider,
          model: config.model,
          keySource: config.keySource,
          ...u,
          costUsd: costUsd(price, u.inputTokens, u.outputTokens),
          latencyMs,
          success: errorCode === null,
          errorCode,
          createdAt: started,
        },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ level: 50, msg: "chat: llm_usage non registrato", message }));
    }
  };

  return {
    async ask(userId: string, messages: LlmChatMessage[]) {
      let config: AiConfig;
      try {
        // shortcut: niente fallback sulla piattaforma se la chiave utente fallisce; aggiungerlo come in extraction.service se serve.
        config = (await d.router.resolveAiConfig(userId)).primary;
      } catch (err) {
        throw toAppError(err, null);
      }

      const { tools, calls, charts } = createChatTools(d.stats, userId);
      const now = d.clock.now();
      const run = async (conversation: LlmChatMessage[]) => {
        const started = d.clock.now();
        try {
          const res = await d.llm.chat({
            provider: config.provider,
            model: config.model,
            apiKey: config.apiKey,
            instructions: instructions(now),
            messages: conversation,
            tools,
            maxSteps: MAX_STEPS,
            abortSignal: AbortSignal.timeout(TIMEOUT_MS),
          });
          await record(userId, config, started, res.usage, null);
          return res.text.trim();
        } catch (err) {
          const llmErr = err instanceof LlmError ? err : null;
          await record(userId, config, started, llmErr?.usage ?? null, llmErr?.kind ?? "internal");
          throw toAppError(err, config.keySource);
        }
      };

      const sources = () => [
        JSON.stringify(calls),
        today(now),
        ...messages.filter((m) => m.role === "user").map((m) => m.content),
      ];
      const check = (text: string) => (text ? ungroundedNumbers(text, sources()) : null);

      let answer = await run(messages);
      let bad = check(answer);
      if (bad === null || bad.length > 0) {
        const retry = [
          ...messages,
          ...(answer ? [{ role: "assistant" as const, content: answer }] : []),
        ];
        answer = await run([...retry, regenerate(bad)]);
        bad = check(answer);
      }
      const grounded = bad !== null && bad.length === 0;

      const unique = new Map<string, ChatChart>();
      for (const c of charts) unique.set(JSON.stringify(c), c);
      return {
        answer: grounded ? answer : UNVERIFIED_ANSWER,
        grounded,
        charts: [...unique.values()].slice(-MAX_CHARTS),
      };
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;

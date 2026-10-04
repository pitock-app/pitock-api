import { Inngest } from "inngest";
import type { Logger } from "pino";
import type { Env } from "../../config/env.js";

type InngestEnv = Pick<
  Env,
  "NODE_ENV" | "INNGEST_EVENT_KEY" | "INNGEST_SIGNING_KEY" | "INNGEST_DEV" | "APP_VERSION"
>;

/** Modalità dev (nessuna verifica della firma, Dev Server locale): solo con `INNGEST_DEV=1` fuori produzione. */
export const inngestDevMode = (env: InngestEnv) => env.INNGEST_DEV && env.NODE_ENV !== "production";

/**
 * `/api/inngest` è servito solo se le richieste sono verificabili (signing key) o in modalità dev
 * esplicita; altrimenti risponde 503.
 */
export const inngestServable = (env: InngestEnv) =>
  inngestDevMode(env) || env.INNGEST_SIGNING_KEY !== undefined;

/** Client Inngest. Con `INNGEST_SIGNING_KEY` le richieste a `/api/inngest` sono verificate. */
export const createInngest = (
  env: InngestEnv,
  /** Logger pino dell'app: JSON con redazione dei segreti anche per i messaggi dell'SDK. */
  logger?: Logger,
) =>
  new Inngest({
    id: "pitock-api",
    appVersion: env.APP_VERSION,
    ...(logger ? { logger } : {}),
    isDev: inngestDevMode(env),
    ...(env.INNGEST_EVENT_KEY ? { eventKey: env.INNGEST_EVENT_KEY } : {}),
    ...(env.INNGEST_SIGNING_KEY ? { signingKey: env.INNGEST_SIGNING_KEY } : {}),
  });

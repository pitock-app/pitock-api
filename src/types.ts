import type { Logger } from "pino";
import type { Container } from "./container.js";

/** Variabili del contesto Hono condivise da middleware e rotte. */
export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
    container: Container;
    userId: string;
    email: string | null;
  };
}

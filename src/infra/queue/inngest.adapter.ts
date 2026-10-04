import type { Inngest } from "inngest";
import type { QueuePort } from "../../ports/queue.port.js";

export function createInngestQueue(inngest: Inngest): QueuePort {
  return {
    async send(name, data) {
      await inngest.send({ name, data });
    },
  };
}

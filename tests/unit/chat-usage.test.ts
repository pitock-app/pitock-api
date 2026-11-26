import { describe, expect, it, vi } from "vitest";
import type { AiRouter } from "../../src/modules/ai/ai-router.js";
import { createChatService } from "../../src/modules/chat/chat.service.js";
import type { StatsRepo } from "../../src/modules/stats/stats.repo.js";
import type { UsageRepo } from "../../src/modules/usage/usage.repo.js";
import { FakeClock, FakeLlm } from "../helpers/fakes.js";

describe("chat: registrazione dell'uso", () => {
  it("risponde anche se llm_usage non si può scrivere", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const usage = {
      findPrice: () => Promise.resolve(null),
      insertMany: () => Promise.reject(new Error("invalid input value for enum llm_operation")),
    } as unknown as UsageRepo;
    const router = {
      resolveAiConfig: () =>
        Promise.resolve({
          primary: { provider: "anthropic", model: "m", apiKey: "k", keySource: "user" },
          fallbackToPlatform: false,
        }),
    } as unknown as AiRouter;
    const chat = createChatService({
      stats: {} as StatsRepo,
      router,
      usage,
      llm: new FakeLlm().respondChat(() => Promise.resolve("Non ho scontrini in questo periodo.")),
      clock: new FakeClock(),
    });

    const res = await chat.ask("u1", [{ role: "user", content: "Quanto ho speso?" }]);

    expect(res).toMatchObject({ answer: "Non ho scontrini in questo periodo.", grounded: true });
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});

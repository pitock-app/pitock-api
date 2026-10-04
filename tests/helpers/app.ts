import { createApp } from "../../src/app.js";
import type { Env } from "../../src/config/env.js";
import { buildContainer, type Container } from "../../src/container.js";
import { createTestAuth, type TestAuth } from "./auth.js";
import { createTestDb, type TestDb } from "./db.js";
import { FakeCatalog, FakeClock, FakeLlm, FakeQueue, FakeStorage, FakeUserAdmin } from "./fakes.js";
import { testEnv } from "./test-env.js";

export interface TestApp {
  app: ReturnType<typeof createApp>;
  env: Env;
  t: TestDb;
  storage: FakeStorage;
  queue: FakeQueue;
  clock: FakeClock;
  llm: FakeLlm;
  catalog: FakeCatalog;
  users: FakeUserAdmin;
  container: Container;
  auth: TestAuth;
  /** Richiesta autenticata come `userId`. */
  call: (userId: string, method: string, path: string, body?: unknown) => Promise<Response>;
  close: () => Promise<void>;
}

/** App completa con DB PGlite, storage e coda fake, JWT firmati localmente. */
export async function createTestApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
  const env = testEnv(envOverrides);
  const t = await createTestDb();
  const storage = new FakeStorage();
  const queue = new FakeQueue();
  const clock = new FakeClock();
  const llm = new FakeLlm();
  const catalog = new FakeCatalog();
  const users = new FakeUserAdmin(t.exec);
  const auth = await createTestAuth();
  const container = buildContainer(env, {
    db: t.db,
    storage,
    queue,
    clock,
    auth: auth.verifier,
    llm,
    catalog,
    users,
  });
  const app = createApp(env, { container });

  return {
    app,
    env,
    t,
    storage,
    queue,
    clock,
    llm,
    catalog,
    users,
    container,
    auth,
    call: async (userId, method, path, body) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await auth.token(userId)}`,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      return app.request(path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    },
    close: () => t.close(),
  };
}

export const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

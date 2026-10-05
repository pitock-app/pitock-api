import { randomUUID } from "node:crypto";
import type { Env } from "../../src/config/env.js";
import { apiKeyContext, createKeyCipher } from "../../src/infra/crypto/key-cipher.js";
import type { Db } from "../../src/infra/db/client.js";
import {
  userAiSettings,
  userApiKeys,
  extractions,
  llmUsage,
  receiptItems,
  receiptsRaw,
} from "../../src/infra/db/schema/index.js";

/** Scontrino da file già estratto da un LLM, come lo lascerà il job di B3. */
export async function seedExtractedFile(
  db: Db,
  userId: string,
  o: {
    merchantName?: string | null;
    merchantBrand?: string | null;
    merchantVat?: string | null;
    createdAt?: Date;
    category?: string | null;
    total?: number | null;
    purchasedAt?: Date | null;
    status?: "extracted" | "failed";
  } = {},
) {
  const id = randomUUID();
  const [receipt] = await db
    .insert(receiptsRaw)
    .values({
      id,
      userId,
      source: "file",
      storagePath: `${userId}/${id}.jpg`,
      sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      originalFilename: "foto.jpg",
      status: o.status ?? "extracted",
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    })
    .returning();
  const [extraction] = await db
    .insert(extractions)
    .values({
      receiptId: id,
      userId,
      method: "llm",
      provider: "anthropic",
      model: "fake-model",
      keySource: "platform",
      promptVersion: "v1",
      rawJson: { is_receipt: true },
      merchantName: o.merchantName === undefined ? "Supermercato" : o.merchantName,
      merchantBrand: o.merchantBrand ?? null,
      merchantVat: o.merchantVat ?? null,
      purchasedAt: o.purchasedAt === undefined ? new Date("2026-09-20T10:00:00Z") : o.purchasedAt,
      total: o.total === undefined ? 12.3 : o.total,
      paymentMethod: "carta",
      category: o.category === undefined ? "alimentari" : o.category,
      confidence: 0.9,
    })
    .returning();
  if (!receipt || !extraction) throw new Error("seed fallito");
  await db.insert(receiptItems).values({
    extractionId: extraction.id,
    userId,
    position: 0,
    description: "Pane",
    amount: 12.3,
  });
  await db.insert(llmUsage).values({
    userId,
    receiptId: id,
    extractionId: extraction.id,
    operation: "extract",
    provider: "anthropic",
    model: "fake-model",
    keySource: "platform",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    latencyMs: 900,
    success: true,
  });
  return { receipt, extraction };
}

/** Impostazioni AI dell'utente e, se data, la sua chiave BYOK cifrata come la salverà B4. */
export async function seedAiSettings(
  db: Db,
  env: Env,
  userId: string,
  o: {
    mode: "platform" | "byok";
    provider?: "anthropic" | "openai" | "openrouter";
    model?: string;
    fallbackToPlatform?: boolean;
    apiKey?: string;
  },
) {
  await db
    .insert(userAiSettings)
    .values({
      userId,
      mode: o.mode,
      provider: o.provider ?? null,
      model: o.model ?? null,
      fallbackToPlatform: o.fallbackToPlatform ?? false,
    })
    .onConflictDoUpdate({
      target: userAiSettings.userId,
      set: {
        mode: o.mode,
        provider: o.provider ?? null,
        model: o.model ?? null,
        fallbackToPlatform: o.fallbackToPlatform ?? false,
      },
    });
  if (o.apiKey && o.provider && env.KEY_ENCRYPTION_SECRET) {
    const cipher = createKeyCipher({ keys: { 1: env.KEY_ENCRYPTION_SECRET }, currentVersion: 1 });
    const enc = cipher.encrypt(o.apiKey, apiKeyContext(userId, o.provider));
    await db.insert(userApiKeys).values({
      userId,
      provider: o.provider,
      ...enc,
      last4: o.apiKey.slice(-4),
      verifiedAt: new Date(),
    });
  }
}

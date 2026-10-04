export interface ModelPrice {
  inputPerMtokUsd: number;
  outputPerMtokUsd: number;
}

/** Costo in USD di una chiamata; `null` se manca il prezzo o il conteggio dei token. */
export function costUsd(
  price: ModelPrice | undefined,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (!price || inputTokens === null || outputTokens === null) return null;
  const cost =
    (inputTokens * price.inputPerMtokUsd + outputTokens * price.outputPerMtokUsd) / 1_000_000;
  return Number(cost.toFixed(6));
}

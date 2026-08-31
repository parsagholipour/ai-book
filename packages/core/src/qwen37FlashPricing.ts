export type Qwen37FlashTextRate = {
  inputPerMillion: number;
  outputPerMillion: number;
};

export type Qwen37FlashCostRate = Qwen37FlashTextRate & {
  label: string;
};

const MODEL_IDS = new Set(["qwen3.7-flash", "qwen3.7-flash-2026-07-15"]);

const PROMPT_TOKEN_BANDS: Array<{
  maxPromptTokens: number | null;
  rate: Qwen37FlashCostRate;
}> = [
  {
    maxPromptTokens: 32_000,
    rate: { inputPerMillion: 0.03, outputPerMillion: 0.13, label: "Up to 32K prompt tokens" }
  },
  {
    maxPromptTokens: 256_000,
    rate: {
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
      label: "Over 32K and up to 256K prompt tokens"
    }
  },
  {
    maxPromptTokens: null,
    rate: { inputPerMillion: 0.2, outputPerMillion: 0.8, label: "Over 256K prompt tokens" }
  }
];

export function qwen37FlashRateForPrompt(model: string | null, promptTokens: number | null): Qwen37FlashTextRate | null {
  if (!model || !MODEL_IDS.has(model)) {
    return null;
  }
  const tokens = promptTokens ?? 0;
  const band = PROMPT_TOKEN_BANDS.find(
    (candidate) => candidate.maxPromptTokens === null || tokens <= candidate.maxPromptTokens
  );
  return band ? { inputPerMillion: band.rate.inputPerMillion, outputPerMillion: band.rate.outputPerMillion } : null;
}

export function qwen37FlashCostRates(model: string | null): Qwen37FlashCostRate[] {
  return model && MODEL_IDS.has(model) ? PROMPT_TOKEN_BANDS.map((band) => ({ ...band.rate })) : [];
}

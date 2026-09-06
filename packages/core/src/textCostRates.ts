/** Provider text rate cards, shared by settlement and the routing cost projection. */
export type TextRate = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheHitPerMillion?: number;
  cacheWritePerMillion?: number;
};

export type TieredTextRate = {
  thresholdPromptTokens: number;
  belowOrEqual: TextRate;
  above: TextRate;
};

export const GEMINI_TEXT_RATES = new Map<string, TextRate | TieredTextRate>([
  [
    "gemini-3.7-flash",
    {
      inputPerMillion: 0.75,
      outputPerMillion: 3.75,
      cacheHitPerMillion: 0.075
    }
  ],
  [
    "gemini-3.5-flash",
    {
      inputPerMillion: 1.5,
      outputPerMillion: 9,
      cacheHitPerMillion: 0.15
    }
  ],
  [
    "gemini-3-flash-preview",
    {
      inputPerMillion: 0.5,
      outputPerMillion: 3,
      cacheHitPerMillion: 0.05
    }
  ],
  [
    "gemini-3.1-flash-lite",
    {
      inputPerMillion: 0.25,
      outputPerMillion: 1.5,
      cacheHitPerMillion: 0.025
    }
  ],
  [
    "gemini-3.1-pro-preview",
    {
      thresholdPromptTokens: 200_000,
      belowOrEqual: {
        inputPerMillion: 2,
        outputPerMillion: 12,
        cacheHitPerMillion: 0.2
      },
      above: {
        inputPerMillion: 4,
        outputPerMillion: 18,
        cacheHitPerMillion: 0.4
      }
    }
  ],
  [
    "gemini-2.5-pro",
    {
      thresholdPromptTokens: 200_000,
      belowOrEqual: {
        inputPerMillion: 1.25,
        outputPerMillion: 10,
        cacheHitPerMillion: 0.125
      },
      above: {
        inputPerMillion: 2.5,
        outputPerMillion: 15,
        cacheHitPerMillion: 0.25
      }
    }
  ],
  [
    "gemini-2.5-flash",
    {
      inputPerMillion: 0.3,
      outputPerMillion: 2.5,
      cacheHitPerMillion: 0.03
    }
  ],
  [
    "gemini-2.5-flash-lite",
    {
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
      cacheHitPerMillion: 0.01
    }
  ]
]);

const GPT_5_NANO_RATE: TextRate = { inputPerMillion: 0.05, outputPerMillion: 0.4, cacheHitPerMillion: 0.005 };

export const OPENAI_TEXT_RATES = new Map<string, TextRate | TieredTextRate>([
  [
    "gpt-5.6-sol",
    {
      thresholdPromptTokens: 272_000,
      belowOrEqual: {
        inputPerMillion: 4,
        outputPerMillion: 20,
        cacheHitPerMillion: 0.4,
        cacheWritePerMillion: 5
      },
      above: { inputPerMillion: 8, outputPerMillion: 30, cacheHitPerMillion: 0.8, cacheWritePerMillion: 10 }
    }
  ],
  [
    "gpt-5.6-terra",
    {
      thresholdPromptTokens: 272_000,
      belowOrEqual: {
        inputPerMillion: 2,
        outputPerMillion: 12,
        cacheHitPerMillion: 0.2,
        cacheWritePerMillion: 2.5
      },
      above: { inputPerMillion: 4, outputPerMillion: 18, cacheHitPerMillion: 0.4, cacheWritePerMillion: 5 }
    }
  ],
  [
    "gpt-5.6-luna",
    {
      thresholdPromptTokens: 272_000,
      belowOrEqual: {
        inputPerMillion: 0.2,
        outputPerMillion: 1.2,
        cacheHitPerMillion: 0.02,
        cacheWritePerMillion: 0.25
      },
      above: { inputPerMillion: 0.4, outputPerMillion: 1.8, cacheHitPerMillion: 0.04, cacheWritePerMillion: 0.5 }
    }
  ],
  ["gpt-5-nano", GPT_5_NANO_RATE],
  ["gpt-5-nano-2025-08-07", GPT_5_NANO_RATE]
]);

export const ALIBABA_TEXT_RATES = new Map<string, TextRate | TieredTextRate>([
  [
    "qwen3.8-max",
    {
      inputPerMillion: 2,
      outputPerMillion: 6,
      cacheHitPerMillion: 0.25
    }
  ],
  [
    "qwen3.7-plus",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.6
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 4.8
      }
    }
  ],
  [
    "qwen3.7-plus-2026-05-26",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.6
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 4.8
      }
    }
  ],
  [
    "qwen3.5-plus",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 2.4
      },
      above: {
        inputPerMillion: 0.5,
        outputPerMillion: 3
      }
    }
  ],
  [
    "qwen3.5-plus-2026-02-15",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 2.4
      },
      above: {
        inputPerMillion: 0.5,
        outputPerMillion: 3
      }
    }
  ],
  [
    "qwen-plus",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.2
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 3.6
      }
    }
  ],
  [
    "qwen-plus-latest",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.2
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 3.6
      }
    }
  ],
  [
    "qwen-plus-2025-12-01",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.2
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 3.6
      }
    }
  ],
  [
    "qwen-plus-2025-09-11",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.2
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 3.6
      }
    }
  ],
  [
    "qwen-plus-2025-07-28",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.4,
        outputPerMillion: 1.2
      },
      above: {
        inputPerMillion: 1.2,
        outputPerMillion: 3.6
      }
    }
  ],
  [
    "qwen-plus-2025-07-14",
    {
      inputPerMillion: 0.4,
      outputPerMillion: 1.2
    }
  ],
  [
    "qwen-plus-2025-04-28",
    {
      inputPerMillion: 0.4,
      outputPerMillion: 1.2
    }
  ],
  [
    "qwen-plus-2025-01-25",
    {
      inputPerMillion: 0.4,
      outputPerMillion: 1.2
    }
  ],
  [
    "qwen3.5-flash",
    {
      inputPerMillion: 0.1,
      outputPerMillion: 0.4
    }
  ],
  [
    "qwen3.5-flash-2026-02-23",
    {
      inputPerMillion: 0.1,
      outputPerMillion: 0.4
    }
  ],
  [
    "qwen-flash",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.05,
        outputPerMillion: 0.4
      },
      above: {
        inputPerMillion: 0.25,
        outputPerMillion: 2
      }
    }
  ],
  [
    "qwen-flash-2025-07-28",
    {
      thresholdPromptTokens: 256_000,
      belowOrEqual: {
        inputPerMillion: 0.05,
        outputPerMillion: 0.4
      },
      above: {
        inputPerMillion: 0.25,
        outputPerMillion: 2
      }
    }
  ]
]);

export type PeakOffPeakRate = {
  offPeak: TextRate;
  peak: TextRate;
};

// Official DeepSeek V4 card as of 2026-08-16. Off-peak is half of peak.
// Peak: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday.
export const DEEPSEEK_V4_FLASH_RATES: PeakOffPeakRate = {
  offPeak: { inputPerMillion: 0.22, outputPerMillion: 0.66, cacheHitPerMillion: 0.007 },
  peak: { inputPerMillion: 0.44, outputPerMillion: 1.32, cacheHitPerMillion: 0.014 }
};

export const DEEPSEEK_V4_PRO_RATES: PeakOffPeakRate = {
  offPeak: { inputPerMillion: 0.66, outputPerMillion: 1.98, cacheHitPerMillion: 0.022 },
  peak: { inputPerMillion: 1.32, outputPerMillion: 3.96, cacheHitPerMillion: 0.044 }
};

export const DEEPINFRA_V4_FLASH_RATE: TextRate = {
  inputPerMillion: 0.1,
  outputPerMillion: 0.2,
  cacheHitPerMillion: 0.02
};

export const DEEPINFRA_V4_PRO_RATE: TextRate = {
  inputPerMillion: 1.3,
  outputPerMillion: 2.6,
  cacheHitPerMillion: 0.1
};

export const DEEPINFRA_MISTRAL_SMALL_RATE: TextRate = {
  inputPerMillion: 0.075,
  outputPerMillion: 0.2
};

// OpenRouter billed card for z-ai/glm-5.3-flash as of 2026-09-02
// (Z.ai 50% promo through 2026-09-09 16:00 UTC).
export const OPENROUTER_GLM_53_FLASH_RATE: TextRate = {
  inputPerMillion: 0.075,
  outputPerMillion: 0.25,
  cacheHitPerMillion: 0.015
};


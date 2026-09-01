import { z } from "zod";
import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_ALIBABA_API_HOST, DEFAULT_ALIBABA_IMAGE_MODEL, DEFAULT_ALIBABA_TEXT_MODEL } from "./adapters/alibabaModels.js";
import { DEFAULT_DEEPINFRA_BASE_URL, DEFAULT_DEEPINFRA_FAST_MODEL, DEFAULT_DEEPINFRA_MODEL } from "./adapters/deepinfraModels.js";
import { DEFAULT_OPENROUTER_BASE_URL } from "./adapters/openrouterModels.js";
import { normalizeGeminiImageModel } from "./adapters/geminiModels.js";
import {
  LEGAL_SUPPORT_EMAIL,
  PUBLIC_ACCOUNT_DELETION_URL,
  PUBLIC_PRIVACY_POLICY_URL,
  PUBLIC_TERMS_OF_SERVICE_URL
} from "./legal.js";

/**
 * Boolean env vars accept the obvious spellings, case-insensitively, and
 * refuse everything else loudly at startup. `MOCK_AI=TRUE` and `MOCK_AI=1`
 * used to parse silently as *false* — running real providers and spending
 * real tokens in a repo whose documented default workflow is `MOCK_AI=true` —
 * and `AUDIOBOOK_OPENAI_FALLBACK_ENABLED=0` silently left the fallback on.
 */
function booleanEnv(name: string): (value: string | undefined) => boolean | undefined {
  return (value) => {
    if (value === undefined) {
      return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "") {
      return undefined;
    }
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
    throw new Error(`${name} must be true or false, got "${value}".`);
  };
}

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().positive().optional(),
  RAILWAY_ENVIRONMENT: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPINFRA_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ALIBABA_API_KEY: z.string().optional(),
  ALIBABA_API_HOST: z.string().url().default(DEFAULT_ALIBABA_API_HOST),
  ALIBABA_TEXT_MODEL: z.string().default(DEFAULT_ALIBABA_TEXT_MODEL),
  ALIBABA_IMAGE_MODEL: z.string().default(DEFAULT_ALIBABA_IMAGE_MODEL),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().default("deepseek-v4-pro"),
  DEEPSEEK_FAST_MODEL: z.string().default("deepseek-v4-flash"),
  DEEPINFRA_BASE_URL: z.string().url().default(DEFAULT_DEEPINFRA_BASE_URL),
  DEEPINFRA_MODEL: z.string().default(DEFAULT_DEEPINFRA_MODEL),
  DEEPINFRA_FAST_MODEL: z.string().default(DEFAULT_DEEPINFRA_FAST_MODEL),
  OPENROUTER_BASE_URL: z.string().url().default(DEFAULT_OPENROUTER_BASE_URL),
  /** OpenAI-compatible local server (Ollama/vLLM/LM Studio) for zero-cost text generation. */
  LOCAL_TEXT_BASE_URL: z.string().url().optional(),
  LOCAL_TEXT_MODEL: z.string().optional(),
  LOCAL_TEXT_API_KEY: z.string().optional(),
  GEMINI_TEXT_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_IMAGE_MODEL: z.string().optional().transform(normalizeGeminiImageModel),
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  GEMINI_TTS_MODEL: z.string().default("gemini-3.1-flash-tts-preview"),
  OPENAI_TTS_MODEL: z.string().default("gpt-4o-mini-tts-2025-12-15"),
  AUDIOBOOK_OPENAI_FALLBACK_ENABLED: z
    .string()
    .optional()
    .transform((value) => booleanEnv("AUDIOBOOK_OPENAI_FALLBACK_ENABLED")(value) ?? true),
  GEMINI_TTS_SAFE_RPD_BUDGET: z.coerce.number().int().min(0).default(90),
  VOICE_CHAT_PROVIDER: z.enum(["openai_realtime", "gemini_live"]).default("gemini_live"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2"),
  OPENAI_REALTIME_VOICE: z.string().default("alloy"),
  GEMINI_LIVE_MODEL: z.string().default("gemini-3.1-flash-live-preview"),
  GEMINI_LIVE_VOICE: z.string().default("Achird"),
  VOICE_RTC_STUN_URLS: z.string().default("stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478"),
  VOICE_RTC_TURN_URLS: z.string().optional(),
  VOICE_RTC_TURN_USERNAME: z.string().optional(),
  VOICE_RTC_TURN_CREDENTIAL: z.string().optional(),
  VOICE_RTC_TURN_SHARED_SECRET: z.string().optional(),
  VOICE_RTC_TURN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  CLOUDFLARE_TURN_TOKEN: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  DATABASE_URL: z
    .string()
    .default("postgresql://bookmaker:bookmaker@localhost:55432/bookmaker?schema=public"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().optional(),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4001"),
  PRIVACY_POLICY_URL: z.string().url().default(PUBLIC_PRIVACY_POLICY_URL),
  TERMS_OF_SERVICE_URL: z.string().url().default(PUBLIC_TERMS_OF_SERVICE_URL),
  ACCOUNT_DELETION_URL: z.string().url().default(PUBLIC_ACCOUNT_DELETION_URL),
  SUPPORT_EMAIL: z.string().email().default(LEGAL_SUPPORT_EMAIL),
  /**
   * SMTP endpoint for transactional mail (password reset codes), e.g.
   * `smtps://user:pass@smtp.example.com:465`. Unset in production disables the
   * forgot-password route with an explicit 503 rather than pretending to send.
   */
  SMTP_URL: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
  EMAIL_FROM: z.string().default("Tomeza <no-reply@ravanix.app>"),
  MOCK_EMAIL: z
    .string()
    .optional()
    .transform(booleanEnv("MOCK_EMAIL")),
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  GOOGLE_PLAY_ACCESS_TOKEN: z.string().optional(),
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: z.string().optional(),
  WEB_PORT: z.coerce.number().int().positive().default(5173),
  WEB_PASSWORD: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
  /**
   * Project whose compiled book.pdf is served, unauthenticated, as the
   * try-before-signup sample at GET /api/mobile/sample-book. Unset means the
   * endpoint answers 404 and the app draws no sample affordance.
   */
  SAMPLE_PROJECT_ID: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
  BOOK_STORAGE_DIR: z.string().default("./storage/books"),
  IMAGE_STORAGE_DIR: z.string().default("./storage/images"),
  VOICE_STORAGE_DIR: z.string().default("./storage/voice"),
  AUDIO_STORAGE_DIR: z.string().default("./storage/audio"),
  ATTACHMENT_STORAGE_DIR: z.string().default("./storage/attachments"),
  /** How long uploaded user files are kept before deletion. Generated books and plans are kept forever. */
  ATTACHMENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(180),
  /**
   * How long a render or publication scratch file must sit untouched before the
   * worker's sweep treats it as abandoned (a process killed before its own
   * cleanup could run). The floor is an hour because the only thing separating
   * an orphan from a live compile in another process is quiet time — see
   * `exportTempSweep.ts`.
   */
  EXPORT_TEMP_RETENTION_HOURS: z.coerce.number().min(1).max(720).default(6),
  MAX_PARALLEL_PAGE_JOBS: z.coerce.number().int().min(1).max(32).default(4),
  MAX_PARALLEL_IMAGE_JOBS: z.coerce.number().int().min(1).max(8).default(2),
  MOCK_AI: z
    .string()
    .optional()
    .transform((value) => booleanEnv("MOCK_AI")(value) ?? false),
  MOCK_GOOGLE_PLAY_BILLING: z
    .string()
    .optional()
    .transform(booleanEnv("MOCK_GOOGLE_PLAY_BILLING"))
}).transform(({ NODE_ENV, PORT, RAILWAY_ENVIRONMENT, API_PORT, MOCK_AI, MOCK_GOOGLE_PLAY_BILLING, MOCK_EMAIL, ...env }) => {
  const nodeEnv = NODE_ENV?.trim() || undefined;
  const devMode = nodeEnv === "development" || nodeEnv === "test";
  return {
    ...env,
    NODE_ENV: nodeEnv,
    MOCK_AI,
    MOCK_GOOGLE_PLAY_BILLING: devMode ? MOCK_GOOGLE_PLAY_BILLING ?? true : false,
    // Same shape as the Play mock: on by default in dev so the reset code lands
    // in the API log instead of requiring an SMTP server, never on in prod.
    MOCK_EMAIL: devMode ? MOCK_EMAIL ?? true : false,
    API_PORT: RAILWAY_ENVIRONMENT ? PORT ?? API_PORT ?? 4001 : API_PORT ?? PORT ?? 4001
  };
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    loadWorkspaceEnv(env);
  }
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    BOOK_STORAGE_DIR: resolveFromWorkspace(parsed.BOOK_STORAGE_DIR),
    IMAGE_STORAGE_DIR: resolveFromWorkspace(parsed.IMAGE_STORAGE_DIR),
    VOICE_STORAGE_DIR: resolveFromWorkspace(parsed.VOICE_STORAGE_DIR),
    AUDIO_STORAGE_DIR: resolveFromWorkspace(parsed.AUDIO_STORAGE_DIR),
    ATTACHMENT_STORAGE_DIR: resolveFromWorkspace(parsed.ATTACHMENT_STORAGE_DIR)
  };
}

export function loadWorkspaceEnv(env: NodeJS.ProcessEnv = process.env): void {
  const workspaceEnvPath = resolve(findWorkspaceRoot(), ".env");
  if (existsSync(workspaceEnvPath)) {
    loadDotenv({ path: workspaceEnvPath, processEnv: env, quiet: true });
  }
}

function resolveFromWorkspace(value: string): string {
  if (isAbsolute(value)) {
    return value;
  }
  return resolve(findWorkspaceRoot(), value);
}

function findWorkspaceRoot(start = process.cwd()): string {
  let current = start;
  while (true) {
    const packagePath = resolve(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const content = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (content.name === "ai-book-maker") {
          return current;
        }
      } catch {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

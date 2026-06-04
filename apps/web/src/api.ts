const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export type AuthStatus = {
  enabled: boolean;
  authenticated: boolean;
};

export type Template = {
  id: string;
  slug: string;
  name: string;
  category:
    | "KIDS"
    | "SCIENCE"
    | "STORY"
    | "EDUCATION"
    | "BUSINESS"
    | "SELF_HELP"
    | "HEALTH"
    | "BIOGRAPHY"
    | "HISTORY"
    | "SOCIETY"
    | "ARTS"
    | "CUSTOM";
  description: string;
};

export type AudienceAgeRange = "2-4" | "4-6" | "6-8";

export type Project = {
  id: string;
  title: string;
  subtitle?: string | null;
  authorName?: string | null;
  coverTagline?: string | null;
  prompt: string;
  category: string;
  subcategory?: string | null;
  targetPages: number;
  complexity: number;
  temperature: number;
  mediaSettings?: {
    generationStrategy?: string;
    textModel?: TextModelSelection;
    imageModel?: ImageModelSelection | string;
    fullIllustrations?: boolean;
    includeCover?: boolean;
    coverTemplate?: string;
    finalReview?: boolean;
    lessCensored?: boolean;
    audienceAgeRange?: AudienceAgeRange;
    toneProfile?: string;
  };
  status: string;
  currentPlan?: PlanVersion | null;
  tokens?: TokenUsage | null;
  cost?: ProjectCost | null;
  _count?: { pages?: number; images?: number; jobs?: number };
};

export type TokenUsage = {
  promptTokens?: number | null;
  outputTokens?: number | null;
  cacheHitTokens?: number | null;
};

export type ProjectCost = {
  textUsd: number;
  imageUsd: number;
  totalUsd: number;
  unpricedTextCalls?: number;
  unpricedImages?: number;
};

export type PlanMessage = {
  role: string;
  content: string;
  at?: string;
};

export type PlanVersion = {
  id: string;
  version: number;
  status: string;
  planningPackage: BookPlan;
  inputSnapshot?: ProjectInputSnapshot | null;
  messages: PlanMessage[];
};

export type ProjectInputSnapshot = {
  title?: string;
  subtitle?: string;
  authorName?: string;
  coverTagline?: string;
  prompt?: string;
  category?: string;
  subcategory?: string;
  targetPages?: number;
  complexity?: number;
  temperature?: number;
  language?: string;
  mediaSettings?: {
    generationStrategy?: string;
    textModel?: TextModelSelection;
    imageModel?: ImageModelSelection | string;
    fullIllustrations?: boolean;
    includeCover?: boolean;
    coverTemplate?: string;
    finalReview?: boolean;
    lessCensored?: boolean;
    audienceAgeRange?: AudienceAgeRange;
    toneProfile?: string;
  };
};

export type TextModelSelection = {
  provider: "deepseek" | "gemini" | "alibaba";
  model: string;
  thinkingBudget?: number;
  thinkingEnabled?: boolean;
};

export type ImageModelSelection = {
  provider: "gemini" | "alibaba";
  model: string;
};

export type PlanQuestion = string | {
  prompt?: string;
  question?: string;
  text?: string;
  options?: string[];
  suggestedAnswers?: string[];
  answers?: string[];
  choices?: string[];
  premadeAnswers?: string[];
  allowCustom?: boolean;
};

export type BookPlan = {
  title: string;
  premise: string;
  audience: string;
  writingComplexity: number;
  voiceGuide: string[];
  antiAiRules: string[];
  questions: PlanQuestion[];
  chapters: Array<{ index: number; title: string; summary: string; targetPages: number; keyBeats: string[] }>;
  characters: Array<{ name: string; role: string; description: string; traits: string[]; visualRules: string[] }>;
  illustrationPlan: {
    cadence: string;
    globalStyle: string;
    coverPrompt?: string;
    pageRules: string[];
  };
};

export type ProjectDetails = Project & {
  pages: Array<{
    id: string;
    index: number;
    title: string;
    markdown: string;
    imagePrompt?: string | null;
    status: string;
  }>;
  images: Array<{ id: string; path: string; prompt: string; type: string }>;
  research: Array<{ id: string; title: string; url?: string; summary: string }>;
};

export type JobStepStatus = "pending" | "active" | "done" | "failed";

export type JobStep = {
  key: string;
  label: string;
  status: JobStepStatus;
};

export type PipelineStep = {
  key: "plan" | "pages" | "images" | "export";
  label: string;
  status: JobStepStatus;
  detail?: string;
};

export type GenerationJobRow = {
  id: string;
  type: string;
  status: string;
  progress: number;
  pageIndex?: number | null;
  message?: string | null;
  error?: string | null;
  tokens?: TokenUsage | null;
  providerDurationMs?: number | null;
  steps?: JobStep[] | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type ProjectStatus = {
  project: Project & {
    jobs: GenerationJobRow[];
  };
  progress: {
    pages: { complete: number; target: number };
    images: number;
    research: number;
    failedJobs: number;
    resumableFailedJobs?: number;
    pipeline?: PipelineStep[];
    tokens: TokenUsage;
    cost?: ProjectCost | null;
    quality?: { reviewedPages: number; repairedPages: number; blockedPages: number };
  };
};

export type RuntimeInfo = {
  mockAi: boolean;
  providers: {
    text: string;
    research: string;
    image: string;
    embedding: string;
  };
  models: {
    text: string;
    fastText: string;
    research: string;
    image: string;
    embedding: string;
  };
  textModelOptions: Array<
    TextModelSelection & {
      label: string;
      preview?: boolean;
      thinking?: boolean;
    }
  >;
  imageModelOptions: Array<{
    provider: "gemini" | "alibaba";
    model: string;
    label: string;
    costUsd?: number;
    supportsReferenceImages: boolean;
    description?: string;
  }>;
  generationStrategies: Array<{
    id: string;
    label: string;
    strengthScore: number;
    recommendedPageRange: { min: number; max: number };
  }>;
};

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { credentials: "include" });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method: "POST",
    credentials: "include"
  };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${API_BASE_URL}${path}`;
}

export function subscribeProjectEvents(
  projectId: string,
  onStatus: (status: ProjectStatus) => void,
  onError?: (error: Event) => void
): () => void {
  const source = new EventSource(`${API_BASE_URL}/api/projects/${projectId}/events`, { withCredentials: true });
  source.addEventListener("status", (event) => {
    try {
      onStatus(JSON.parse((event as MessageEvent).data) as ProjectStatus);
    } catch {
      /* ignore malformed payloads */
    }
  });
  source.onerror = (error) => {
    onError?.(error);
  };
  return () => source.close();
}

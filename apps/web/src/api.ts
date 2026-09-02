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
    coverArtSource?: string;
    coverTemplate?: string;
    finalReview?: boolean;
    audienceAgeRange?: AudienceAgeRange;
    toneProfile?: string;
    parallelPageGeneration?: boolean;
    draftCandidates?: number;
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
  cacheWriteTokens?: number | null;
  provisionalPromptTokens?: number | null;
  provisionalOutputTokens?: number | null;
  inFlightCalls?: number | null;
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
    coverArtSource?: string;
    coverTemplate?: string;
    finalReview?: boolean;
    audienceAgeRange?: AudienceAgeRange;
    toneProfile?: string;
    parallelPageGeneration?: boolean;
    draftCandidates?: number;
  };
};

export type TextModelSelection = {
  provider: "deepseek" | "deepinfra" | "openrouter" | "gemini" | "alibaba" | "openai" | "openai-compatible";
  model: string;
  thinkingBudget?: number;
  thinkingEnabled?: boolean;
  thinkingEffort?: TextModelThinkingEffort;
};

export type TextModelThinkingEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type TextModelThinkingEffortOption = {
  value: TextModelThinkingEffort;
  label: string;
  default?: boolean;
};

export type ImageModelSelection = {
  provider: "gemini" | "alibaba";
  model: string;
};

export type VoiceChatProviderId = "openai_realtime" | "gemini_live";
export type VoiceTransport = "webrtc_sdp" | "gemini_live";

export type VoiceProviderInfo = {
  id: VoiceChatProviderId;
  label: string;
  configured: boolean;
  default: boolean;
  transport: VoiceTransport;
  model: string;
  modelOptions: VoiceModelOption[];
};

export type VoiceModelOption = {
  model: string;
  label: string;
  default: boolean;
  description?: string;
};

export type VoiceAgeBand = "child" | "teen" | "young_adult" | "adult" | "elder";
export type VoiceGenderPresentation = "feminine" | "masculine" | "neutral" | "unknown";
export type VoiceProfile = {
  ageBand: VoiceAgeBand;
  genderPresentation: VoiceGenderPresentation;
  energy: "low" | "medium" | "high";
  warmth: "low" | "medium" | "high";
  pace: "slow" | "medium" | "fast";
  formality: "casual" | "balanced" | "formal";
  accentNotes?: string;
};

export type VoiceCharacterStatus = "CANDIDATE" | "APPROVED" | "BUILDING" | "READY" | "REJECTED" | "FAILED";

export type VoiceCharacter = {
  id: string;
  projectId: string;
  planVersionId?: string | null;
  name: string;
  role: string;
  description: string;
  traits: string[];
  visualRules: string[];
  source: string;
  status: VoiceCharacterStatus;
  persona?: Record<string, unknown> | null;
  voiceProfile: VoiceProfile;
  voiceProvider: string;
  voiceModel?: string | null;
  voiceId?: string | null;
  callProvider?: VoiceChatProviderId;
  callTransport?: VoiceTransport;
  providerMetadata?: Record<string, unknown> | null;
  profileImageAssetId?: string | null;
  profileImage?: { id: string; path: string; prompt: string; type: string } | null;
  error?: string | null;
  approvedAt?: string | null;
  builtAt?: string | null;
};

export type OpenAIRealtimeVoiceCallSession = {
  type: "webrtc_sdp_answer";
  answerSdp: string;
  provider: "openai_realtime";
  model: string;
  voiceId: string;
  metadata: Record<string, unknown>;
};

export type GeminiLiveVoiceCallSession = {
  type: "gemini_live_token";
  token: string;
  expiresAt: string;
  newSessionExpiresAt: string;
  provider: "gemini_live";
  model: string;
  voiceId: string;
  metadata: Record<string, unknown>;
};

export type VoiceCallSession = OpenAIRealtimeVoiceCallSession | GeminiLiveVoiceCallSession;

export type VoiceConversationTurn = {
  speakerId: string;
  speakerName: string;
  text: string;
};

export type VoiceConversationCharacterSnapshot = {
  id: string;
  name: string;
  role?: string | null;
  description?: string | null;
  voiceName: string;
  temporary?: boolean;
};

export type VoiceConversation = {
  id: string;
  projectId: string;
  parentConversationId?: string | null;
  rootConversationId?: string | null;
  prompt: string;
  characters: VoiceConversationCharacterSnapshot[];
  transcript: {
    title?: string;
    turns: VoiceConversationTurn[];
  };
  provider: string;
  model: string;
  audioPath: string;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
};

export type CreateVoiceConversationRequest = {
  prompt: string;
  characterIds?: string[];
  continuationOfConversationId?: string;
};

export type OpenAIVoiceRoomParticipantRequest = {
  characterId: string;
  offerSdp: string;
};

export type GeminiVoiceRoomParticipantRequest = {
  characterId: string;
  sessionHandle?: string;
};

export type CreateVoiceRoomSessionRequest =
  | {
      provider: "openai_realtime";
      transport: "webrtc_sdp";
      voiceModel?: string;
      listenerOfferSdp: string;
      participants: OpenAIVoiceRoomParticipantRequest[];
    }
  | {
      provider: "gemini_live";
      transport: "gemini_live";
      voiceModel?: string;
      listenerSessionHandle?: string;
      participants: GeminiVoiceRoomParticipantRequest[];
    };

export type VoiceRoomSessionResponse = {
  provider: VoiceChatProviderId;
  voiceModel: string;
  listener: VoiceCallSession;
  participants: Array<{ characterId: string; session: VoiceCallSession }>;
};

export type VoiceRtcIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: "password";
};

export type VoiceRtcConfig = {
  iceServers: VoiceRtcIceServer[];
  issuedAt: string;
  ttlSeconds: number;
  relayConfigured: boolean;
};

export type VoiceCallEventPhase =
  | "connect_start"
  | "connected"
  | "disconnected"
  | "reconnect_start"
  | "reconnect_success"
  | "reconnect_failed"
  | "failed"
  | "ended";

export type VoiceCallEventPayload = {
  clientCallId: string;
  phase: VoiceCallEventPhase;
  attempt?: number;
  elapsedMs?: number;
  connectionState?: string;
  iceConnectionState?: string;
  iceGatheringState?: string;
  candidatePairType?: string;
  candidateProtocol?: string;
  currentRoundTripTimeMs?: number;
  packetsLost?: number;
  jitterMs?: number;
  error?: string;
  metadata?: Record<string, string | number | boolean | null>;
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
  chapters: Array<{
    index: number;
    title: string;
    summary: string;
    targetPages: number;
    keyBeats: string[];
    illustrationPrompts?: string[];
  }>;
  characters: Array<{ name: string; role: string; description: string; traits: string[]; visualRules: string[] }>;
  illustrationPlan: {
    cadence: string;
    globalStyle: string;
    coverPrompt?: string;
    pageRules: string[];
  };
  /** The author the composed-chapters pipeline writes as; absent on older plans until the pass writes one. */
  authorStance?: unknown;
};

/** What the router chose for a project, resolved server-side because the router lives in core's barrel. */
export type ResolvedGenerationStrategy = {
  id: string;
  label: string;
  executionMode: string;
  pipeline: "per-page" | "composed";
  requestedId: string;
  autoSelected: boolean;
  switched: boolean;
  warnings: string[];
};

export type ProjectDetails = Project & {
  resolvedStrategy?: ResolvedGenerationStrategy;
  chapters?: Array<{
    id: string;
    index: number;
    title: string;
    summary: string;
    targetPages: number;
    /** The derived brief; for composed books it carries `composition` and `report` beside the page beats. */
    productionBrief?: unknown;
  }>;
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
  payload?: Record<string, unknown> | null;
  pageIndex?: number | null;
  message?: string | null;
  error?: string | null;
  tokens?: TokenUsage | null;
  providerDurationMs?: number | null;
  imageFallbacks?: JobImageFallbackDetails[];
  steps?: JobStep[] | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type JobImageFallbackDetails = {
  status: "attempting" | "used" | "failed";
  primary: {
    provider: string;
    model: string;
    error?: string;
  };
  fallback: {
    provider: string;
    model: string;
    error?: string;
  };
  result?: {
    provider: string;
    model: string;
  };
  occurredAt?: string;
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

export type ProjectPdfStatus = {
  available: boolean;
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
      thinkingEfforts?: TextModelThinkingEffortOption[];
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

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
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

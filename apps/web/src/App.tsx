import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CircleStop,
  Circle,
  Download,
  Images,
  Info,
  ListChecks,
  LockKeyhole,
  LogOut,
  Loader2,
  MessageSquareText,
  Play,
  Plus,
  RefreshCcw,
  Send,
  SkipForward,
  Sparkles,
  XCircle
} from "lucide-react";
import {
  apiGet,
  apiPost,
  apiUrl,
  subscribeProjectEvents,
  type AuthStatus,
  type AudienceAgeRange,
  type GenerationJobRow,
  type ImageModelSelection,
  type JobStep,
  type PipelineStep,
  type Project,
  type ProjectCost,
  type ProjectDetails,
  type ProjectInputSnapshot,
  type ProjectStatus,
  type RuntimeInfo,
  type Template,
  type TextModelSelection,
  type TokenUsage
} from "./api.js";
import { normalizeProjectStatus, resolveJobDisplaySteps, resolvePipelineSteps } from "./jobsDisplay.js";

type ProjectCategory =
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
type ToneProfile = "neutral" | "confident" | "skeptical" | "scholarly" | "conversational" | "narrative";
type CoverTemplateId = "auto" | "kids" | "science" | "fiction" | "minimal" | "business" | "self-help" | "romance";

type DraftProject = {
  title: string;
  subtitle: string;
  authorName: string;
  coverTagline: string;
  prompt: string;
  category: ProjectCategory;
  subcategory: string;
  customSubcategory: string;
  generationStrategy: string;
  textModel: TextModelSelection;
  imageModel: ImageModelSelection;
  coverTemplate: CoverTemplateId;
  audienceAgeRange: AudienceAgeRange;
  targetPages: number;
  complexity: number;
  temperature: number;
  fullIllustrations: boolean;
  includeCover: boolean;
  finalReview: boolean;
  lessCensored: boolean;
  toneProfile: ToneProfile;
};

type GenerationStrategyOption = RuntimeInfo["generationStrategies"][number];
type TextModelOption = RuntimeInfo["textModelOptions"][number];
type ImageModelOption = RuntimeInfo["imageModelOptions"][number];
type ProjectHoverState = {
  project: Project;
  x: number;
  y: number;
} | null;

type NormalizedPlanQuestion = {
  id: string;
  prompt: string;
  options: string[];
  allowCustom: boolean;
};

type QuestionResponse = {
  status: "answered" | "skipped";
  answer?: string;
};

const SELECTED_PROJECT_STORAGE_KEY = "ai-book-maker:selected-project-id";
const CUSTOM_SUBCATEGORY_VALUE = "__custom";
const DEFAULT_GENERATION_STRATEGY_ID = "chaptered-sequential";
const DEFAULT_TONE_PROFILE: ToneProfile = "neutral";
const DEFAULT_TEXT_MODEL: TextModelSelection = { provider: "deepseek", model: "deepseek-v4-pro" };
const DEFAULT_IMAGE_MODEL: ImageModelSelection = { provider: "gemini", model: "gemini-2.5-flash-image" };
const TOKEN_FORMATTER = new Intl.NumberFormat();
const USD_FORMATTER = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const PRECISE_USD_FORMATTER = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
});
const CATEGORY_OPTIONS: Array<{ value: ProjectCategory; label: string }> = [
  { value: "KIDS", label: "Kids' books" },
  { value: "SCIENCE", label: "Science & nature" },
  { value: "STORY", label: "Fiction & stories" },
  { value: "EDUCATION", label: "Education & how-to" },
  { value: "BUSINESS", label: "Business & career" },
  { value: "SELF_HELP", label: "Self-help & relationships" },
  { value: "HEALTH", label: "Health & wellness" },
  { value: "BIOGRAPHY", label: "Biography & memoir" },
  { value: "HISTORY", label: "History" },
  { value: "SOCIETY", label: "Society & culture" },
  { value: "ARTS", label: "Arts & poetry" },
  { value: "CUSTOM", label: "General / custom" }
];
const PROJECT_CATEGORY_VALUES = CATEGORY_OPTIONS.map((category) => category.value);
const CATEGORY_LABELS = Object.fromEntries(
  CATEGORY_OPTIONS.map((category) => [category.value, category.label])
) as Record<ProjectCategory, string>;
const SUBCATEGORY_OPTIONS: Record<ProjectCategory, string[]> = {
  KIDS: [
    "Picture book",
    "Early reader",
    "Bedtime story",
    "Learning & school",
    "Adventure",
    "Friendship & feelings",
    "Folktale & fairy tale",
    "Middle grade"
  ],
  SCIENCE: [
    "Space & astronomy",
    "Biology & nature",
    "Physics",
    "Climate & environment",
    "Technology",
    "Medicine & health",
    "Mathematics",
    "Earth science"
  ],
  STORY: [
    "Literary fiction",
    "Romance",
    "Fantasy",
    "Mystery & thriller",
    "Science fiction",
    "Horror",
    "Historical fiction",
    "Adventure"
  ],
  EDUCATION: [
    "How-to guide",
    "Study guide",
    "Workbook",
    "Language learning",
    "Parenting & teaching",
    "Reference",
    "Career skills",
    "DIY & crafts"
  ],
  BUSINESS: [
    "Entrepreneurship",
    "Marketing & sales",
    "Leadership",
    "Career development",
    "Personal finance",
    "Investing",
    "Product & startups",
    "Management"
  ],
  SELF_HELP: [
    "Personal growth",
    "Productivity",
    "Mindfulness",
    "Relationships",
    "Communication",
    "Creativity",
    "Confidence",
    "Life transitions"
  ],
  HEALTH: [
    "Nutrition",
    "Fitness",
    "Mental health",
    "Sleep",
    "Medicine & patient education",
    "Public health",
    "Aging & longevity",
    "Wellness"
  ],
  BIOGRAPHY: [
    "Memoir",
    "Autobiography",
    "Profile",
    "Family history",
    "Travel memoir",
    "Creative nonfiction",
    "Leadership biography",
    "Historical biography"
  ],
  HISTORY: [
    "Ancient history",
    "Medieval history",
    "Modern history",
    "Military history",
    "Political history",
    "Cultural history",
    "Local history",
    "True crime"
  ],
  SOCIETY: [
    "Politics & government",
    "Social issues",
    "Culture & media",
    "Philosophy & ideas",
    "Religion & spirituality",
    "Economics",
    "Law & justice",
    "Environment & society"
  ],
  ARTS: [
    "Poetry",
    "Art & design",
    "Photography",
    "Music",
    "Film & theater",
    "Writing craft",
    "Comics & graphic novels",
    "Food & travel"
  ],
  CUSTOM: [
    "Essay collection",
    "Journal / workbook",
    "Research report",
    "Manifesto",
    "Worldbuilding bible",
    "Brand book",
    "Newsletter-to-book",
    "Other niche format"
  ]
};
const DEFAULT_GENERATION_STRATEGIES: GenerationStrategyOption[] = [
  {
    id: "chaptered-sequential",
    label: "Chaptered sequential generation",
    strengthScore: 7,
    recommendedPageRange: { min: 12, max: 80 }
  },
  {
    id: "whole-book-single-pass",
    label: "Whole book single pass",
    strengthScore: 3,
    recommendedPageRange: { min: 5, max: 20 }
  },
  {
    id: "page-map-sequential",
    label: "Page-map sequential generation",
    strengthScore: 8,
    recommendedPageRange: { min: 12, max: 120 }
  },
  {
    id: "chapter-whole-pass",
    label: "Chapter whole-pass generation",
    strengthScore: 7,
    recommendedPageRange: { min: 16, max: 120 }
  },
  {
    id: "batch-window",
    label: "Batch window generation",
    strengthScore: 6,
    recommendedPageRange: { min: 12, max: 80 }
  },
  {
    id: "draft-then-polish",
    label: "Draft then polish",
    strengthScore: 9,
    recommendedPageRange: { min: 5, max: 40 }
  },
  {
    id: "research-grounded",
    label: "Research-grounded generation",
    strengthScore: 9,
    recommendedPageRange: { min: 12, max: 80 }
  },
  {
    id: "research-map-draft-polish",
    label: "Research map draft & polish",
    strengthScore: 10,
    recommendedPageRange: { min: 12, max: 80 }
  }
];
const DEFAULT_TEXT_MODEL_OPTIONS: TextModelOption[] = [
  { ...DEFAULT_TEXT_MODEL, label: `DeepSeek (${DEFAULT_TEXT_MODEL.model})` }
];
const DEFAULT_IMAGE_MODEL_OPTIONS: ImageModelOption[] = [
  {
    provider: DEFAULT_IMAGE_MODEL.provider,
    model: DEFAULT_IMAGE_MODEL.model,
    label: "Gemini 2.5 Flash Image",
    costUsd: 0.039,
    supportsReferenceImages: true,
    description: "Best for books with recurring characters."
  }
];
const TONE_PROFILE_OPTIONS: Array<{ id: ToneProfile; label: string; hint: string }> = [
  { id: "neutral", label: "Neutral", hint: "Balanced and natural" },
  { id: "confident", label: "Confident", hint: "Assertive without proof-leaps" },
  { id: "skeptical", label: "Skeptical", hint: "Careful about easy conclusions" },
  { id: "scholarly", label: "Scholarly", hint: "Measured and source-aware" },
  { id: "conversational", label: "Conversational", hint: "Plainspoken and warm" },
  { id: "narrative", label: "Narrative", hint: "Scene and example led" }
];
const AUDIENCE_AGE_RANGE_OPTIONS: Array<{ value: AudienceAgeRange; label: string }> = [
  { value: "2-4", label: "Ages 2-4" },
  { value: "4-6", label: "Ages 4-6" },
  { value: "6-8", label: "Ages 6-8" }
];

const initialDraft: DraftProject = {
  title: "",
  subtitle: "",
  authorName: "",
  coverTagline: "",
  prompt: "A curious child discovers that the moon keeps a tiny library of forgotten bedtime stories.",
  category: "KIDS",
  subcategory: "",
  customSubcategory: "",
  generationStrategy: DEFAULT_GENERATION_STRATEGY_ID,
  textModel: DEFAULT_TEXT_MODEL,
  imageModel: DEFAULT_IMAGE_MODEL,
  coverTemplate: "auto",
  audienceAgeRange: "4-6",
  targetPages: 32,
  complexity: 3,
  temperature: 0.8,
  fullIllustrations: true,
  includeCover: true,
  finalReview: true,
  lessCensored: false,
  toneProfile: DEFAULT_TONE_PROFILE
};

const resumableJobTypes = new Set(["GENERATE_BOOK", "GENERATE_PAGE", "GENERATE_IMAGE", "COMPILE_EXPORT"]);
const CREATE_PROJECT_ACTION_KEY = "create-project";

export function App() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectHover, setProjectHover] = useState<ProjectHoverState>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => projectIdFromCurrentPath());
  const [detailsByProjectId, setDetailsByProjectId] = useState<Record<string, ProjectDetails>>({});
  const [statusByProjectId, setStatusByProjectId] = useState<Record<string, ProjectStatus>>({});
  const [bookMarkdownByProjectId, setBookMarkdownByProjectId] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<DraftProject>(initialDraft);
  const [planMessage, setPlanMessage] = useState("");
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [questionResponses, setQuestionResponses] = useState<Record<string, QuestionResponse>>({});
  const [submittedQuestionResponseMessage, setSubmittedQuestionResponseMessage] = useState("");
  const [customQuestionAnswer, setCustomQuestionAnswer] = useState("");
  const [busyActions, setBusyActions] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const selectedDetails = selectedId ? detailsByProjectId[selectedId] ?? null : null;
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? selectedDetails,
    [projects, selectedId, selectedDetails]
  );
  const selectedBookMarkdown = selectedId ? bookMarkdownByProjectId[selectedId] ?? "" : "";
  const textModelOptions = runtime?.textModelOptions?.length ? runtime.textModelOptions : DEFAULT_TEXT_MODEL_OPTIONS;
  const imageModelOptions = runtime?.imageModelOptions?.length ? runtime.imageModelOptions : DEFAULT_IMAGE_MODEL_OPTIONS;
  const hydratedDraftSourceRef = useRef<string | null>(null);

  useEffect(() => {
    void refreshAuthStatus();
  }, []);

  useEffect(() => {
    const handlePopState = () => setSelectedId(projectIdFromCurrentPath());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (authStatus?.authenticated) {
      void refreshAll();
    }
  }, [authStatus?.authenticated]);

  const lastPageCompleteByProjectIdRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!selectedProject) {
      hydratedDraftSourceRef.current = null;
      return;
    }

    const sourceKey = `${selectedProject.id}:${selectedProject.currentPlan?.id ?? "project"}`;
    if (hydratedDraftSourceRef.current === sourceKey) {
      return;
    }

    setDraft(draftFromSavedInputs(selectedProject));
    hydratedDraftSourceRef.current = sourceKey;
  }, [selectedProject]);

  useEffect(() => {
    const fallback = textModelOptions[0];
    if (!fallback) {
      return;
    }
    setDraft((current) =>
      textModelOptions.some((option) => sameTextModel(option, current.textModel))
        ? current
        : { ...current, textModel: textModelSelectionFromOption(fallback) }
    );
  }, [textModelOptions]);

  useEffect(() => {
    const fallback = imageModelOptions[0];
    if (!fallback) {
      return;
    }
    setDraft((current) =>
      imageModelOptions.some((option) => sameImageModel(option, current.imageModel))
        ? current
        : { ...current, imageModel: imageModelSelectionFromOption(fallback) }
    );
  }, [imageModelOptions]);

  useEffect(() => {
    if (!selectedId) {
      syncProjectPath(null);
      return;
    }
    syncProjectPath(selectedId);
    localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, selectedId);
    if (!authStatus?.authenticated) {
      return;
    }
    void refreshProject(selectedId);
    const detailsTimer = setInterval(() => void refreshProject(selectedId), 6000);
    return () => clearInterval(detailsTimer);
  }, [authStatus?.authenticated, selectedId]);

  useEffect(() => {
    if (!selectedId || !authStatus?.authenticated) {
      return;
    }
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    const loadStatus = async () => {
      try {
        const statusData = await apiGet<ProjectStatus>(`/api/projects/${selectedId}/status`);
        if (!closed) {
          const normalizedStatus = cacheProjectStatus(statusData);
          lastPageCompleteByProjectIdRef.current[selectedId] = normalizedStatus.progress.pages.complete;
        }
      } catch (refreshError) {
        if (!closed) {
          setError(readError(refreshError));
        }
      }
    };

    void loadStatus();
    const unsubscribe = subscribeProjectEvents(
      selectedId,
      (statusData) => {
        const normalizedStatus = cacheProjectStatus(statusData);
        const complete = normalizedStatus.progress.pages.complete;
        if (complete > (lastPageCompleteByProjectIdRef.current[selectedId] ?? 0)) {
          lastPageCompleteByProjectIdRef.current[selectedId] = complete;
          void refreshBookMarkdown(selectedId);
          void refreshProjectDetails(selectedId);
        }
      },
      () => {
        if (!pollTimer) {
          pollTimer = setInterval(() => void loadStatus(), 3000);
        }
      }
    );

    return () => {
      closed = true;
      unsubscribe();
      if (pollTimer) {
        clearInterval(pollTimer);
      }
    };
  }, [authStatus?.authenticated, selectedId]);

  async function refreshAuthStatus() {
    try {
      setAuthError(null);
      setAuthStatus(await apiGet<AuthStatus>("/api/auth/status"));
    } catch (authStatusError) {
      setAuthStatus({ enabled: true, authenticated: false });
      setAuthError(readError(authStatusError));
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const nextAuthStatus = await apiPost<AuthStatus>("/api/auth/login", { password: authPassword });
      setAuthStatus(nextAuthStatus);
      setAuthPassword("");
    } catch (loginError) {
      setAuthError(readError(loginError));
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    setAuthBusy(true);
    setError(null);
    setAuthError(null);
    try {
      const nextAuthStatus = await apiPost<AuthStatus>("/api/auth/logout");
      setAuthStatus(nextAuthStatus);
      setProjects([]);
      setSelectedId(null);
      setDetailsByProjectId({});
      setStatusByProjectId({});
      setBookMarkdownByProjectId({});
    } catch (logoutError) {
      setAuthError(readError(logoutError));
    } finally {
      setAuthBusy(false);
    }
  }

  async function refreshAll() {
    try {
      setError(null);
      const [runtimeData, templateData, projectData] = await Promise.all([
        apiGet<RuntimeInfo>("/api/runtime"),
        apiGet<Template[]>("/api/templates"),
        apiGet<Project[]>("/api/projects")
      ]);
      setRuntime(runtimeData);
      setTemplates(templateData);
      setProjects(projectData);
      if (projectData.length === 0) {
        setSelectedId(null);
        setDetailsByProjectId({});
        setStatusByProjectId({});
        setBookMarkdownByProjectId({});
        return;
      }
      const storedId = localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
      const nextId =
        (selectedId && projectData.some((project) => project.id === selectedId) ? selectedId : null) ??
        (storedId && projectData.some((project) => project.id === storedId) ? storedId : null) ??
        projectData[0]!.id;
      setSelectedId(nextId);
    } catch (refreshError) {
      setError(readError(refreshError));
    }
  }

  function cacheProjectStatus(statusData: ProjectStatus): ProjectStatus {
    const normalizedStatus = normalizeProjectStatus(statusData);
    setStatusByProjectId((current) => ({ ...current, [normalizedStatus.project.id]: normalizedStatus }));
    setProjects((current) =>
      current.map((project) => {
        if (project.id !== normalizedStatus.project.id) {
          return project;
        }

        const nextProject: Project = {
          ...project,
          status: normalizedStatus.project.status,
          tokens: normalizedStatus.progress.tokens
        };
        if (normalizedStatus.project.currentPlan !== undefined) {
          nextProject.currentPlan = normalizedStatus.project.currentPlan;
        }
        if (normalizedStatus.progress.cost !== undefined) {
          nextProject.cost = normalizedStatus.progress.cost;
        }
        return nextProject;
      })
    );
    return normalizedStatus;
  }

  function isActionBusy(key: string): boolean {
    return Boolean(busyActions[key]);
  }

  async function runBusyAction(key: string, action: () => Promise<void>): Promise<void> {
    setBusyActions((current) => ({ ...current, [key]: true }));
    try {
      await action();
    } finally {
      setBusyActions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  async function refreshProjectDetails(id: string) {
    try {
      const detailData = await apiGet<ProjectDetails>(`/api/projects/${id}`);
      setDetailsByProjectId((current) => ({ ...current, [detailData.id]: detailData }));
      setProjects((current) =>
        current.map((project) => {
          if (project.id !== detailData.id) {
            return project;
          }

          const mergedProject = { ...project, ...detailData };
          const tokens = detailData.tokens ?? project.tokens;
          return tokens === undefined ? mergedProject : { ...mergedProject, tokens };
        })
      );
    } catch (refreshError) {
      setError(readError(refreshError));
    }
  }

  async function refreshBookMarkdown(id: string) {
    try {
      const markdown = await fetch(apiUrl(`/api/projects/${id}/book`), { credentials: "include" }).then((response) =>
        response.ok ? response.text() : ""
      );
      setBookMarkdownByProjectId((current) => ({ ...current, [id]: markdown }));
    } catch {
      /* book may not exist yet */
    }
  }

  async function refreshProject(id: string) {
    await Promise.all([refreshProjectDetails(id), refreshBookMarkdown(id)]);
    try {
      const statusData = cacheProjectStatus(await apiGet<ProjectStatus>(`/api/projects/${id}/status`));
      lastPageCompleteByProjectIdRef.current[id] = statusData.progress.pages.complete;
    } catch (refreshError) {
      setError(readError(refreshError));
    }
  }

  async function createProject() {
    await runBusyAction(CREATE_PROJECT_ACTION_KEY, async () => {
      setError(null);
      try {
        const project = await apiPost<Project>("/api/projects", projectInputFromDraft(draft, textModelOptions));
        await apiPost(`/api/projects/${project.id}/plan`);
        await refreshAll();
        setSelectedId(project.id);
      } catch (createError) {
        setError(readError(createError));
      }
    });
  }

  async function createPlan() {
    const projectId = selectedId;
    if (!projectId) return;
    await runBusyAction(projectPlanActionKey(projectId), async () => {
      try {
        await apiPost(`/api/projects/${projectId}/plan`, projectInputFromDraft(draft, textModelOptions));
        await refreshProject(projectId);
      } catch (planError) {
        setError(readError(planError));
      }
    });
  }

  async function revisePlanWithMessage(message: string, onSuccess?: () => void) {
    const planId = selectedDetails?.currentPlan?.id;
    const projectId = selectedDetails?.id;
    const trimmedMessage = message.trim();
    if (!planId || !projectId || !trimmedMessage) return;
    await runBusyAction(planRevisionActionKey(planId), async () => {
      try {
        await apiPost(`/api/plans/${planId}/messages`, { message: trimmedMessage });
        onSuccess?.();
        await refreshProject(projectId);
      } catch (revisionError) {
        setError(readError(revisionError));
      }
    });
  }

  async function revisePlan() {
    await revisePlanWithMessage(planMessage, () => setPlanMessage(""));
  }

  async function approvePlan() {
    const planId = selectedDetails?.currentPlan?.id;
    const projectId = selectedDetails?.id;
    if (!planId || !projectId) return;
    await runBusyAction(planApproveActionKey(planId), async () => {
      try {
        await apiPost(`/api/plans/${planId}/approve`);
        await refreshProject(projectId);
      } catch (approveError) {
        setError(readError(approveError));
      }
    });
  }

  async function resumeProject() {
    const projectId = selectedId;
    if (!projectId) return;
    await runBusyAction(projectResumeActionKey(projectId), async () => {
      setError(null);
      try {
        await apiPost(`/api/projects/${projectId}/resume`);
        await refreshProject(projectId);
      } catch (resumeError) {
        setError(readError(resumeError));
      }
    });
  }

  async function stopProject() {
    const projectId = selectedId;
    if (!projectId) return;
    await runBusyAction(projectStopActionKey(projectId), async () => {
      setError(null);
      try {
        await apiPost(`/api/projects/${projectId}/stop`);
        await refreshProject(projectId);
      } catch (stopError) {
        setError(readError(stopError));
      }
    });
  }

  async function regenerateCover() {
    const projectId = selectedId;
    if (!projectId) return;
    await runBusyAction(projectCoverActionKey(projectId), async () => {
      setError(null);
      try {
        await apiPost(`/api/projects/${projectId}/cover`);
        await refreshProject(projectId);
      } catch (coverError) {
        setError(readError(coverError));
      }
    });
  }

  const plan = selectedDetails?.currentPlan?.planningPackage;
  const planQuestions = useMemo(() => normalizePlanQuestions(plan?.questions), [plan?.questions]);
  const activeQuestion = planQuestions[activeQuestionIndex];
  const questionResponseMessage = useMemo(
    () => buildQuestionResponseMessage(planQuestions, questionResponses),
    [planQuestions, questionResponses]
  );
  const planMessages = normalizePlanMessages(selectedDetails?.currentPlan?.messages);
  const pagePrompts =
    selectedDetails?.pages
      .filter((page) => page.imagePrompt?.trim())
      .map((page) => ({ index: page.index, prompt: page.imagePrompt!.trim() })) ?? [];
  const imagePrompts =
    selectedDetails?.images
      .filter((image) => image.prompt.trim())
      .map((image) => ({ type: image.type, prompt: image.prompt.trim() })) ?? [];
  const coverImage = selectedDetails?.images.find((image) => image.type === "COVER");
  const characterReferenceImages = selectedDetails?.images.filter((image) => image.type === "CHARACTER_REFERENCE") ?? [];
  const pageImages =
    selectedDetails?.images.filter((image) => image.type !== "COVER" && image.type !== "CHARACTER_REFERENCE") ?? [];
  const selectedStatus = selectedId ? statusByProjectId[selectedId] ?? null : null;
  const pageProgress = selectedStatus?.progress.pages;
  const resumableFailedJobs = selectedStatus?.progress.resumableFailedJobs ?? 0;
  const hasVisibleFailedGenerationJob =
    selectedStatus?.project.jobs.some((job) => job.status === "FAILED" && resumableJobTypes.has(job.type)) ?? false;
  const latestPlanRevisionStatus = selectedStatus?.project.jobs.find((job) => job.type === "REVISE_PLAN")?.status;
  const hasActivePlanRevision = latestPlanRevisionStatus === "QUEUED" || latestPlanRevisionStatus === "ACTIVE";
  const currentPlanId = selectedDetails?.currentPlan?.id ?? null;
  const createProjectBusy = isActionBusy(CREATE_PROJECT_ACTION_KEY);
  const createPlanBusy = selectedId ? isActionBusy(projectPlanActionKey(selectedId)) : false;
  const revisionBusy = currentPlanId ? isActionBusy(planRevisionActionKey(currentPlanId)) : false;
  const approveBusy = currentPlanId ? isActionBusy(planApproveActionKey(currentPlanId)) : false;
  const resumeBusy = selectedId ? isActionBusy(projectResumeActionKey(selectedId)) : false;
  const stopBusy = selectedId ? isActionBusy(projectStopActionKey(selectedId)) : false;
  const coverBusy = selectedId ? isActionBusy(projectCoverActionKey(selectedId)) : false;
  const approvePlanDisabled = approveBusy || !plan || hasActivePlanRevision;
  const canResumeProject = resumableFailedJobs > 0 || hasVisibleFailedGenerationJob;
  const canStopProject =
    selectedStatus?.project.jobs.some((job) => job.status === "QUEUED" || job.status === "ACTIVE") ?? false;
  const progressPercent =
    pageProgress && pageProgress.target > 0 ? Math.round((pageProgress.complete / pageProgress.target) * 100) : 0;
  const qualityProgress = selectedStatus?.progress.quality;
  const projectTokens = selectedStatus?.progress.tokens ?? selectedProject?.tokens;
  const strategyOptions = runtime?.generationStrategies?.length
    ? runtime.generationStrategies
    : DEFAULT_GENERATION_STRATEGIES;
  const selectedStrategy =
    strategyOptions.find((strategy) => strategy.id === draft.generationStrategy) ?? strategyOptions[0];
  const selectedTextModel = resolveTextModelOption(textModelOptions, draft.textModel);
  const selectedImageModel = resolveImageModelOption(imageModelOptions, draft.imageModel);
  const showImageModelControls = draft.fullIllustrations || draft.includeCover;
  const activeStrategyId =
    selectedStatus?.project.mediaSettings?.generationStrategy ??
    selectedProject?.mediaSettings?.generationStrategy ??
    DEFAULT_GENERATION_STRATEGY_ID;
  const activeGenerationStrategy = resolveGenerationStrategy(strategyOptions, activeStrategyId);
  const subcategoryOptions = SUBCATEGORY_OPTIONS[draft.category];
  const hasQuestionResponses = planQuestions.some((question) => questionResponses[question.id]);
  const submittedQuestionResponses =
    hasQuestionResponses &&
    latestPlanRevisionStatus !== "FAILED" &&
    submittedQuestionResponseMessage === questionResponseMessage;

  useEffect(() => {
    setActiveQuestionIndex(0);
    setQuestionResponses({});
    setSubmittedQuestionResponseMessage("");
    setCustomQuestionAnswer("");
  }, [selectedId]);

  useEffect(() => {
    setQuestionResponses((current) => pruneQuestionResponses(planQuestions, current));
  }, [planQuestions]);

  useEffect(() => {
    if (planQuestions.length === 0 && activeQuestionIndex !== 0) {
      setActiveQuestionIndex(0);
      return;
    }
    if (activeQuestionIndex >= planQuestions.length) {
      setActiveQuestionIndex(Math.max(0, planQuestions.length - 1));
    }
  }, [activeQuestionIndex, planQuestions.length]);

  function goToPlanQuestion(index: number) {
    const boundedIndex = Math.min(Math.max(index, 0), Math.max(0, planQuestions.length - 1));
    const nextQuestion = planQuestions[boundedIndex];
    const response = nextQuestion ? questionResponses[nextQuestion.id] : undefined;
    const isCustomAnswer =
      nextQuestion && response?.status === "answered" && !nextQuestion.options.includes(response.answer ?? "");

    setActiveQuestionIndex(boundedIndex);
    setCustomQuestionAnswer(isCustomAnswer ? response?.answer ?? "" : "");
  }

  function answerActiveQuestion(answer: string) {
    if (!activeQuestion) return;
    const trimmedAnswer = answer.trim();
    if (!trimmedAnswer) return;

    setQuestionResponses((current) => ({
      ...current,
      [activeQuestion.id]: { status: "answered", answer: trimmedAnswer }
    }));
    const nextIndex = activeQuestionIndex + 1;
    setCustomQuestionAnswer("");
    if (nextIndex < planQuestions.length) {
      setActiveQuestionIndex(nextIndex);
    }
  }

  function skipActiveQuestion() {
    if (!activeQuestion) return;

    setQuestionResponses((current) => ({
      ...current,
      [activeQuestion.id]: { status: "skipped" }
    }));
    const nextIndex = activeQuestionIndex + 1;
    setCustomQuestionAnswer("");
    if (nextIndex < planQuestions.length) {
      setActiveQuestionIndex(nextIndex);
    }
  }

  async function submitQuestionResponses() {
    if (planQuestions.length === 0) return;
    const responseCount = planQuestions.filter((question) => questionResponses[question.id]).length;
    if (responseCount === 0 || submittedQuestionResponses || hasActivePlanRevision) return;

    await revisePlanWithMessage(questionResponseMessage, () => {
      setSubmittedQuestionResponseMessage(questionResponseMessage);
    });
  }

  if (!authStatus) {
    return (
      <AuthShell>
        <Loader2 className="spin" size={26} aria-hidden />
        <p>Checking access…</p>
      </AuthShell>
    );
  }

  if (!authStatus.authenticated) {
    return (
      <LoginScreen
        password={authPassword}
        busy={authBusy}
        error={authError}
        onPasswordChange={setAuthPassword}
        onSubmit={login}
      />
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <BookOpen size={24} aria-hidden />
          <div>
            <h1>AI Book Maker</h1>
            <p>Local generation console</p>
          </div>
        </div>
        {authStatus.enabled ? (
          <button className="icon-text-button auth-logout" type="button" onClick={logout} disabled={authBusy}>
            {authBusy ? <Loader2 className="spin" size={16} /> : <LogOut size={16} />}
            Log out
          </button>
        ) : null}

        <section className="tool-panel">
          <div className="panel-title">
            <Plus size={18} aria-hidden />
            <h2>New Project</h2>
          </div>
          <label>
            Title
            <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </label>
          <label>
            Subtitle
            <input value={draft.subtitle} onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })} />
          </label>
          <label>
            Author
            <input
              value={draft.authorName}
              onChange={(event) => setDraft({ ...draft, authorName: event.target.value })}
            />
          </label>
          <label>
            Cover tagline
            <input
              value={draft.coverTagline}
              onChange={(event) => setDraft({ ...draft, coverTagline: event.target.value })}
            />
          </label>
          <label>
            Category
            <select
              value={draft.category}
              onChange={(event) => {
                const category = event.target.value as DraftProject["category"];
                setDraft({
                  ...draft,
                  category,
                  subcategory: "",
                  customSubcategory: "",
                  lessCensored: category === "KIDS" ? false : draft.lessCensored
                });
              }}
            >
              {CATEGORY_OPTIONS.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Subcategory
            <select
              value={draft.subcategory}
              onChange={(event) => setDraft({ ...draft, subcategory: event.target.value, customSubcategory: "" })}
            >
              <option value="">None</option>
              {subcategoryOptions.map((subcategory) => (
                <option key={subcategory} value={subcategory}>
                  {subcategory}
                </option>
              ))}
              <option value={CUSTOM_SUBCATEGORY_VALUE}>Custom</option>
            </select>
          </label>
          {draft.subcategory === CUSTOM_SUBCATEGORY_VALUE ? (
            <label>
              Custom subcategory
              <input
                value={draft.customSubcategory}
                maxLength={80}
                onChange={(event) => setDraft({ ...draft, customSubcategory: event.target.value })}
              />
            </label>
          ) : null}
          <label>
            Strategy
            <select
              value={draft.generationStrategy}
              onChange={(event) => setDraft({ ...draft, generationStrategy: event.target.value })}
            >
              {strategyOptions.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.label} — {strategy.strengthScore}/10
                </option>
              ))}
            </select>
            {selectedStrategy ? (
              <p className="field-hint strategy-field-hint">
                <span>
                  Strength {selectedStrategy.strengthScore}/10 — higher scores use more QA passes and tighter
                  continuity.
                </span>
                <span className="strategy-info">
                  <button
                    type="button"
                    className="strategy-info-trigger"
                    aria-label={`Show recommendation for ${selectedStrategy.label}`}
                  >
                    <Info size={14} aria-hidden />
                  </button>
                  <span className="strategy-info-popover" role="tooltip">
                    <span>
                      <strong>Recommended page size</strong>
                      <small>{formatRecommendedPageRange(selectedStrategy.recommendedPageRange)}</small>
                    </span>
                    <span>
                      <strong>Accuracy score</strong>
                      <small>{selectedStrategy.strengthScore}/10</small>
                    </span>
                  </span>
                </span>
              </p>
            ) : null}
          </label>
          <label>
            AI model
            <select
              value={textModelKey(selectedTextModel)}
              onChange={(event) =>
                setDraft({ ...draft, textModel: textModelSelectionFromKey(event.target.value, textModelOptions) })
              }
            >
              {textModelOptions.map((option) => (
                <option key={textModelKey(option)} value={textModelKey(option)}>
                  {textModelLabel(option)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tone
            <select
              value={draft.toneProfile}
              onChange={(event) =>
                setDraft({ ...draft, toneProfile: toneProfileFromValue(event.target.value) })
              }
            >
              {TONE_PROFILE_OPTIONS.map((tone) => (
                <option key={tone.id} value={tone.id}>
                  {tone.label} — {tone.hint}
                </option>
              ))}
            </select>
          </label>
          <label>
            First prompt
            <textarea
              rows={5}
              value={draft.prompt}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </label>
          {draft.category === "KIDS" ? (
            <label>
              Age range
              <select
                value={draft.audienceAgeRange}
                onChange={(event) =>
                  setDraft({ ...draft, audienceAgeRange: audienceAgeRangeFromValue(event.target.value) })
                }
              >
                {AUDIENCE_AGE_RANGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="two-col">
            <label>
              Pages
              <input
                type="number"
                min={1}
                max={600}
                value={draft.targetPages}
                onChange={(event) => setDraft({ ...draft, targetPages: Number(event.target.value) })}
              />
            </label>
            <label>
              Complexity
              <input
                type="range"
                min={1}
                max={10}
                value={draft.complexity}
                onChange={(event) => setDraft({ ...draft, complexity: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="two-col">
            <label>
              Temperature (0-2)
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature}
                onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.fullIllustrations}
                onChange={(event) => setDraft({ ...draft, fullIllustrations: event.target.checked })}
              />
              Images
            </label>
          </div>
          {showImageModelControls ? (
            <>
              <label>
                Image model
                <select
                  value={imageModelKey(selectedImageModel)}
                  onChange={(event) =>
                    setDraft({ ...draft, imageModel: imageModelSelectionFromKey(event.target.value, imageModelOptions) })
                  }
                >
                  {imageModelOptions.map((option) => (
                    <option key={imageModelKey(option)} value={imageModelKey(option)}>
                      {imageModelLabel(option)}
                    </option>
                  ))}
                </select>
              </label>
              {!selectedImageModel.supportsReferenceImages ? (
                <p className="field-hint">
                  This image model does not use character reference sheets, so recurring character consistency may be
                  weaker.
                </p>
              ) : null}
            </>
          ) : null}
          <div className="two-col">
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.includeCover}
                onChange={(event) => setDraft({ ...draft, includeCover: event.target.checked })}
              />
              Cover
            </label>
            <label>
              Cover template
              <select
                value={draft.coverTemplate}
                onChange={(event) =>
                  setDraft({ ...draft, coverTemplate: event.target.value as DraftProject["coverTemplate"] })
                }
              >
                <option value="auto">Auto</option>
                <option value="kids">Kids</option>
                <option value="science">Science</option>
                <option value="fiction">Fiction</option>
                <option value="minimal">Minimal</option>
                <option value="business">Business</option>
                <option value="self-help">Self-help</option>
                <option value="romance">Romance</option>
              </select>
            </label>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.finalReview}
              onChange={(event) => setDraft({ ...draft, finalReview: event.target.checked })}
            />
            Final review before export
          </label>
          {draft.category !== "KIDS" ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={draft.lessCensored}
                onChange={(event) => setDraft({ ...draft, lessCensored: event.target.checked })}
              />
              Less censored
            </label>
          ) : null}
          {draft.category !== "KIDS" && draft.lessCensored ? (
            <p className="field-hint">
              Uses stronger prompts and retries to reduce refusals; some material may still be blocked by the AI
              provider.
            </p>
          ) : null}
          <button className="primary-button" onClick={createProject} disabled={createProjectBusy || draft.prompt.length < 10}>
            {createProjectBusy ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            Create & Plan
          </button>
        </section>

        <section className="project-list">
          <div className="panel-title">
            <ListChecks size={18} aria-hidden />
            <h2>Projects</h2>
            <button className="icon-button" onClick={refreshAll} title="Refresh projects">
              <RefreshCcw size={16} />
            </button>
          </div>
          {projects.map((project) => (
            <button
              key={project.id}
              className={project.id === selectedId ? "project-button active" : "project-button"}
              onClick={() => setSelectedId(project.id)}
              onBlur={() => setProjectHover(null)}
              onFocus={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setProjectHover({ project, ...projectPopoverPoint(rect.right - 20, rect.bottom - 8) });
              }}
              onMouseEnter={(event) =>
                setProjectHover({ project, ...projectPopoverPoint(event.clientX, event.clientY) })
              }
              onMouseLeave={() => setProjectHover(null)}
              onMouseMove={(event) =>
                setProjectHover({ project, ...projectPopoverPoint(event.clientX, event.clientY) })
              }
            >
              <div className="project-button-summary">
                <div className="project-button-main">
                  <span className="project-button-title">{project.title}</span>
                  <small>{project.status}</small>
                </div>
                <small className="project-cost-summary">{formatProjectCost(project.cost)}</small>
              </div>
              <small className="project-model-summary">
                {formatProjectAiModels(project, textModelOptions, imageModelOptions)}
              </small>
            </button>
          ))}
        </section>
      </aside>

      {projectHover ? (
        <div className="project-hover-popover" style={{ left: projectHover.x, top: projectHover.y }} role="tooltip">
          <span>
            <strong>Strategy</strong>
            <small>{projectStrategyLabel(projectHover.project, strategyOptions)}</small>
          </span>
          <span>
            <strong>Tone</strong>
            <small>{projectToneLabel(projectHover.project)}</small>
          </span>
          <span>
            <strong>Pages</strong>
            <small>{formatProjectPages(projectHover.project)}</small>
          </span>
          <span>
            <strong>Text cost</strong>
            <small>{formatUsd(projectHover.project.cost?.textUsd)}</small>
          </span>
          <span>
            <strong>Image cost</strong>
            <small>{formatUsd(projectHover.project.cost?.imageUsd)}</small>
          </span>
          <span>
            <strong>Total</strong>
            <small>{formatUsd(projectHover.project.cost?.totalUsd)}</small>
          </span>
        </div>
      ) : null}

      <section className="workspace">
        {runtime?.mockAi ? (
          <div className="mock-banner">
            <AlertTriangle size={20} aria-hidden />
            <div>
              <strong>MOCK_AI is on.</strong>
              <span> Plans, pages, and images are deterministic placeholders until the API and worker restart without `MOCK_AI=true`.</span>
            </div>
          </div>
        ) : null}
        {error ? <div className="error-banner">{error}</div> : null}
        {!selectedProject ? (
          <div className="empty-state">Create a project to start planning a book.</div>
        ) : (
          <>
            <header className="workspace-header">
              <div>
                <p className="eyebrow">{formatProjectCategory(selectedProject.category, selectedProject.subcategory)}</p>
                <h2>{selectedProject.title}</h2>
              </div>
              <div className="status-pill">{selectedProject.status}</div>
            </header>
            {selectedProject.prompt ? (
              <section className="prompt-panel">
                <div className="section-title">
                  <MessageSquareText size={18} />
                  <h3>Original prompt</h3>
                </div>
                <p className="saved-prompt">{selectedProject.prompt}</p>
              </section>
            ) : null}

            <div className="metrics-row">
              <Metric label="Pages" value={`${pageProgress?.complete ?? 0}/${pageProgress?.target ?? selectedProject.targetPages}`} />
              <Metric label="Images" value={String(selectedStatus?.progress.images ?? selectedDetails?.images.length ?? 0)} />
              <Metric label="Research" value={String(selectedStatus?.progress.research ?? selectedDetails?.research.length ?? 0)} />
              <Metric label="Input Tokens" value={formatTokenCount(projectTokens?.promptTokens)} />
              <Metric label="Output Tokens" value={formatTokenCount(projectTokens?.outputTokens)} />
              <Metric
                label="QA"
                value={
                  qualityProgress
                    ? `${qualityProgress.reviewedPages}/${selectedProject.targetPages}${qualityProgress.blockedPages ? ` blocked ${qualityProgress.blockedPages}` : ""}`
                    : "0"
                }
              />
              <Metric label="Progress" value={`${progressPercent}%`} />
            </div>

            <div className="progress-track">
              <div style={{ width: `${progressPercent}%` }} />
            </div>

            <div className="main-grid">
              <section className="work-section">
                <div className="section-title">
                  <MessageSquareText size={18} />
                  <h3>Plan</h3>
                  <button
                    className="icon-text-button"
                    onClick={createPlan}
                    disabled={createPlanBusy || !selectedId || draft.prompt.length < 10}
                  >
                    {createPlanBusy ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
                    Regenerate
                  </button>
                  <button className="icon-text-button accent" onClick={approvePlan} disabled={approvePlanDisabled}>
                    {approveBusy || hasActivePlanRevision ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                    {approveBusy || hasActivePlanRevision ? "Loading" : "Approve"}
                  </button>
                </div>
                {plan ? (
                  <div className="plan-grid">
                    <div>
                      <h4>{plan.title}</h4>
                      <p>{plan.premise}</p>
                      <p className="muted">{plan.audience}</p>
                    </div>
                    <div>
                      <h4>Voice</h4>
                      <ul>{plan.voiceGuide.map((item) => <li key={item}>{item}</li>)}</ul>
                    </div>
                    <div>
                      <h4>Illustrations</h4>
                      <p>{plan.illustrationPlan.globalStyle}</p>
                    </div>
                  </div>
                ) : (
                  <p className="muted">No plan yet. Generate a plan to begin the approval workflow.</p>
                )}
                <PlanQuestionStepper
                  questions={planQuestions}
                  responses={questionResponses}
                  activeIndex={activeQuestionIndex}
                  customAnswer={customQuestionAnswer}
                  busy={revisionBusy}
                  revisionPending={hasActivePlanRevision}
                  responsesSubmitted={submittedQuestionResponses}
                  onAnswer={answerActiveQuestion}
                  onCustomAnswerChange={setCustomQuestionAnswer}
                  onGoTo={goToPlanQuestion}
                  onSkip={skipActiveQuestion}
                  onSubmit={submitQuestionResponses}
                />
                <div className="chapter-list">
                  {plan?.chapters.map((chapter) => (
                    <article key={chapter.index}>
                      <span>{chapter.index}</span>
                      <div>
                        <h4>{chapter.title}</h4>
                        <p>{chapter.summary}</p>
                      </div>
                      <small>{chapter.targetPages} pages</small>
                    </article>
                  ))}
                </div>
                {planMessages.length > 0 ? (
                  <div className="plan-messages">
                    <h4>Revision history</h4>
                    <ul>
                      {planMessages.map((message, index) => (
                        <li key={`${message.at ?? "message"}-${index}`}>
                          <small>{message.at ? new Date(message.at).toLocaleString() : "Saved revision"}</small>
                          <p>{message.content}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="revision-row">
                  <textarea
                    rows={3}
                    value={planMessage}
                    onChange={(event) => setPlanMessage(event.target.value)}
                    placeholder="Ask for outline, character, style, or illustration changes before approval."
                  />
                  <button className="primary-button compact" onClick={revisePlan} disabled={revisionBusy || !planMessage.trim()}>
                    {revisionBusy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
                    Send
                  </button>
                </div>
              </section>

              <section className="work-section">
                <div className="section-title">
                  <CheckCircle2 size={18} />
                  <h3>Jobs</h3>
                  {canStopProject || canResumeProject ? (
                    <div className="job-controls">
                      {canStopProject ? (
                        <button className="icon-text-button danger" onClick={stopProject} disabled={stopBusy || !selectedId}>
                          {stopBusy ? <Loader2 className="spin" size={16} /> : <CircleStop size={16} />}
                          Stop
                        </button>
                      ) : null}
                      {canResumeProject ? (
                        <button className="icon-text-button accent" onClick={resumeProject} disabled={resumeBusy || !selectedId}>
                          {resumeBusy ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
                          Resume
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="job-strategy-summary">
                  <Sparkles size={16} aria-hidden />
                  <div>
                    <span>Strategy</span>
                    <strong>{activeGenerationStrategy.label}</strong>
                  </div>
                  <small>Strength {activeGenerationStrategy.strengthScore}/10</small>
                </div>
                <div className="pipeline-stepper">
                  {resolvePipelineSteps(selectedStatus).map((step, index, steps) => (
                    <PipelineStepItem key={step.key} step={step} isLast={index === steps.length - 1} />
                  ))}
                </div>
                <div className="jobs-list">
                  {selectedStatus?.project.jobs.map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </div>
              </section>
            </div>

            <section className="preview-grid">
              <div className="preview-images-column">
                <div className="work-section">
                  <div className="section-title">
                    <Images size={18} />
                    <h3>Cover</h3>
                    <button
                      className="icon-text-button"
                      onClick={regenerateCover}
                      disabled={coverBusy || !selectedId || !selectedDetails?.currentPlan}
                    >
                      {coverBusy ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
                      Regenerate
                    </button>
                  </div>
                  {coverImage ? (
                    <figure className="cover-preview">
                      <img src={apiUrl(coverImage.path)} alt={coverImage.prompt} />
                      <figcaption>Cover PNG</figcaption>
                    </figure>
                  ) : (
                    <div className="cover-placeholder">Cover will appear here after generation.</div>
                  )}
                </div>
                <div className="work-section">
                  <div className="section-title">
                    <Images size={18} />
                    <h3>Images</h3>
                  </div>
                  <div className="image-grid">
                    {pageImages.map((image) => (
                      <figure key={image.id}>
                        <img src={apiUrl(image.path)} alt={image.prompt} />
                        <figcaption>{image.type}</figcaption>
                      </figure>
                    ))}
                    {pageImages.length === 0 ? <p className="muted">Page images will appear here after generation.</p> : null}
                  </div>
                </div>
                {characterReferenceImages.length > 0 ? (
                  <div className="work-section">
                    <div className="section-title">
                      <Images size={18} />
                      <h3>Character References</h3>
                    </div>
                    <div className="image-grid">
                      {characterReferenceImages.map((image) => (
                        <figure key={image.id}>
                          <img src={apiUrl(image.path)} alt={image.prompt} />
                          <figcaption>Character reference</figcaption>
                        </figure>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="work-section">
                <div className="section-title">
                  <BookOpen size={18} />
                  <h3>Markdown Preview</h3>
                  <a className="icon-text-button" href={apiUrl(`/api/projects/${selectedProject.id}/export/readme`)}>
                    <Download size={16} />
                    Markdown
                  </a>
                  {selectedProject.status === "COMPLETE" ? (
                    <a className="icon-text-button" href={apiUrl(`/api/projects/${selectedProject.id}/export/pdf`)}>
                      <Download size={16} />
                      PDF
                    </a>
                  ) : null}
                </div>
                <pre className="markdown-preview">
                  {selectedBookMarkdown || "Generated pages will appear here after the first page is saved."}
                </pre>
              </div>
              <div className="work-section">
                <div className="section-title">
                  <MessageSquareText size={18} />
                  <h3>Saved prompts</h3>
                </div>
                {pagePrompts.length === 0 && imagePrompts.length === 0 ? (
                  <p className="muted">Image and page prompts are saved as generation completes.</p>
                ) : (
                  <div className="prompt-log">
                    {pagePrompts.map((entry) => (
                      <article key={`page-${entry.index}`}>
                        <h4>Page {entry.index}</h4>
                        <pre>{entry.prompt}</pre>
                      </article>
                    ))}
                    {imagePrompts.map((entry, index) => (
                      <article key={`image-${entry.type}-${index}`}>
                        <h4>{entry.type}</h4>
                        <pre>{entry.prompt}</pre>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}

function AuthShell(props: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">{props.children}</section>
    </main>
  );
}

function LoginScreen(props: {
  password: string;
  busy: boolean;
  error: string | null;
  onPasswordChange: (password: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <AuthShell>
      <div className="auth-icon">
        <LockKeyhole size={28} aria-hidden />
      </div>
      <div>
        <p className="eyebrow">Protected console</p>
        <h1>AI Book Maker</h1>
        <p className="muted">Enter the password from your `.env` file to continue.</p>
      </div>
      <form className="auth-form" onSubmit={props.onSubmit}>
        <label>
          Password
          <input
            autoFocus
            type="password"
            value={props.password}
            onChange={(event) => props.onPasswordChange(event.target.value)}
            placeholder="WEB_PASSWORD"
          />
        </label>
        {props.error ? <div className="error-banner">{props.error}</div> : null}
        <button className="primary-button" type="submit" disabled={props.busy || !props.password.trim()}>
          {props.busy ? <Loader2 className="spin" size={18} /> : <LockKeyhole size={18} />}
          Unlock
        </button>
      </form>
    </AuthShell>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function projectIdFromCurrentPath(): string | null {
  return projectIdFromPath(window.location.pathname);
}

function projectIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

function syncProjectPath(projectId: string | null): void {
  const nextPath = projectId ? `/projects/${encodeURIComponent(projectId)}` : "/";
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (currentPath !== nextPath) {
    window.history.pushState(null, "", nextPath);
  }
}

function projectPlanActionKey(projectId: string): string {
  return `project:${projectId}:plan`;
}

function projectResumeActionKey(projectId: string): string {
  return `project:${projectId}:resume`;
}

function projectStopActionKey(projectId: string): string {
  return `project:${projectId}:stop`;
}

function projectCoverActionKey(projectId: string): string {
  return `project:${projectId}:cover`;
}

function planRevisionActionKey(planId: string): string {
  return `plan:${planId}:revision`;
}

function planApproveActionKey(planId: string): string {
  return `plan:${planId}:approve`;
}

function projectInputFromDraft(draft: DraftProject, textModelOptions: TextModelOption[]) {
  const selectedSubcategory =
    draft.subcategory === CUSTOM_SUBCATEGORY_VALUE ? draft.customSubcategory.trim() : draft.subcategory.trim();
  const textModel = resolveTextModelOption(textModelOptions, draft.textModel);

  return {
    title: draft.title.trim() || undefined,
    subtitle: draft.subtitle.trim() || undefined,
    authorName: draft.authorName.trim() || undefined,
    coverTagline: draft.coverTagline.trim() || undefined,
    prompt: draft.prompt,
    category: draft.category,
    subcategory: selectedSubcategory || undefined,
    targetPages: draft.targetPages,
    complexity: draft.complexity,
    temperature: draft.temperature,
    mediaSettings: {
      fullIllustrations: draft.fullIllustrations,
      illustrationCadence: "template-driven",
      includeCover: draft.includeCover,
      coverTemplate: draft.coverTemplate,
      imageModel: imageModelSelectionFromOption(draft.imageModel),
      finalReview: draft.finalReview,
      lessCensored: draft.category === "KIDS" ? false : draft.lessCensored,
      generationStrategy: draft.generationStrategy,
      textModel: textModelSelectionFromOption(textModel),
      ...(draft.category === "KIDS" ? { audienceAgeRange: draft.audienceAgeRange } : {}),
      toneProfile: draft.toneProfile
    }
  };
}

function draftFromSavedInputs(project: Project): DraftProject {
  const snapshot: ProjectInputSnapshot | null = project.currentPlan?.inputSnapshot ?? null;
  const category = projectCategoryFromValue(firstString(snapshot?.category, project.category));
  const mediaSettings = {
    ...(project.mediaSettings ?? {}),
    ...(snapshot?.mediaSettings ?? {})
  };
  const subcategory = draftSubcategoryFromValue(category, firstString(snapshot?.subcategory, project.subcategory));

  return {
    title: firstString(snapshot?.title, project.title),
    subtitle: firstString(snapshot?.subtitle, project.subtitle),
    authorName: firstString(snapshot?.authorName, project.authorName),
    coverTagline: firstString(snapshot?.coverTagline, project.coverTagline),
    prompt: firstString(snapshot?.prompt, project.prompt, initialDraft.prompt),
    category,
    subcategory: subcategory.subcategory,
    customSubcategory: subcategory.customSubcategory,
    generationStrategy: firstString(mediaSettings.generationStrategy, DEFAULT_GENERATION_STRATEGY_ID),
    textModel: textModelSelectionFromValue(mediaSettings.textModel),
    imageModel: imageModelSelectionFromValue(mediaSettings.imageModel),
    coverTemplate: coverTemplateFromValue(firstString(mediaSettings.coverTemplate, initialDraft.coverTemplate)),
    targetPages: clampInt(
      firstFiniteNumber(snapshot?.targetPages, project.targetPages) ?? initialDraft.targetPages,
      1,
      600
    ),
    complexity: clampInt(
      firstFiniteNumber(snapshot?.complexity, project.complexity) ?? initialDraft.complexity,
      1,
      10
    ),
    temperature: clampNumber(
      firstFiniteNumber(snapshot?.temperature, project.temperature) ?? initialDraft.temperature,
      0,
      2
    ),
    fullIllustrations: firstBoolean(mediaSettings.fullIllustrations, initialDraft.fullIllustrations),
    includeCover: firstBoolean(mediaSettings.includeCover, initialDraft.includeCover),
    finalReview: firstBoolean(mediaSettings.finalReview, initialDraft.finalReview),
    lessCensored: category === "KIDS" ? false : firstBoolean(mediaSettings.lessCensored, initialDraft.lessCensored),
    audienceAgeRange:
      category === "KIDS" ? audienceAgeRangeFromValue(mediaSettings.audienceAgeRange) : initialDraft.audienceAgeRange,
    toneProfile: toneProfileFromValue(firstString(mediaSettings.toneProfile, initialDraft.toneProfile))
  };
}

function audienceAgeRangeFromValue(value: unknown): AudienceAgeRange {
  return value === "2-4" || value === "4-6" || value === "6-8" ? value : initialDraft.audienceAgeRange;
}

function projectCategoryFromValue(value: string): ProjectCategory {
  return isProjectCategory(value) ? value : initialDraft.category;
}

function isProjectCategory(value: string): value is ProjectCategory {
  return PROJECT_CATEGORY_VALUES.includes(value as ProjectCategory);
}

function draftSubcategoryFromValue(
  category: ProjectCategory,
  value: string
): Pick<DraftProject, "subcategory" | "customSubcategory"> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { subcategory: "", customSubcategory: "" };
  }
  if (SUBCATEGORY_OPTIONS[category].includes(trimmed)) {
    return { subcategory: trimmed, customSubcategory: "" };
  }
  return { subcategory: CUSTOM_SUBCATEGORY_VALUE, customSubcategory: trimmed };
}

function coverTemplateFromValue(value: string): DraftProject["coverTemplate"] {
  return value === "kids" ||
    value === "science" ||
    value === "fiction" ||
    value === "minimal" ||
    value === "business" ||
    value === "self-help" ||
    value === "romance"
    ? value
    : "auto";
}

function toneProfileFromValue(value: string): ToneProfile {
  return value === "confident" ||
    value === "skeptical" ||
    value === "scholarly" ||
    value === "conversational" ||
    value === "narrative" ||
    value === "neutral"
    ? value
    : DEFAULT_TONE_PROFILE;
}

function textModelSelectionFromValue(value: unknown): TextModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_TEXT_MODEL;
  }
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  const model = record.model;
  if (
    (provider === "deepseek" || provider === "gemini" || provider === "alibaba") &&
    typeof model === "string" &&
    model.trim()
  ) {
    const thinkingBudget = record.thinkingBudget;
    const thinkingEnabled = record.thinkingEnabled;
    return {
      provider,
      model: model.trim(),
      ...(typeof thinkingBudget === "number" && Number.isFinite(thinkingBudget)
        ? { thinkingBudget: Math.trunc(thinkingBudget) }
        : {}),
      ...(typeof thinkingEnabled === "boolean" ? { thinkingEnabled } : {})
    };
  }
  return DEFAULT_TEXT_MODEL;
}

function imageModelSelectionFromValue(value: unknown): ImageModelSelection {
  if (typeof value === "string" && value.trim()) {
    return { provider: "gemini", model: value.trim().replace(/^models\//, "") };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_IMAGE_MODEL;
  }
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  const model = record.model;
  if ((provider === "gemini" || provider === "alibaba") && typeof model === "string" && model.trim()) {
    return { provider, model: model.trim().replace(/^models\//, "") };
  }
  return DEFAULT_IMAGE_MODEL;
}

function textModelSelectionFromOption(option: TextModelSelection): TextModelSelection {
  return {
    provider: option.provider,
    model: option.model,
    ...(typeof option.thinkingBudget === "number" ? { thinkingBudget: option.thinkingBudget } : {}),
    ...(typeof option.thinkingEnabled === "boolean" ? { thinkingEnabled: option.thinkingEnabled } : {})
  };
}

function imageModelSelectionFromOption(option: ImageModelSelection): ImageModelSelection {
  return {
    provider: option.provider,
    model: option.model
  };
}

function textModelSelectionFromKey(key: string, options: TextModelOption[]): TextModelSelection {
  const option =
    options.find((candidate) => textModelKey(candidate) === key) ?? options[0] ?? DEFAULT_TEXT_MODEL_OPTIONS[0]!;
  return textModelSelectionFromOption(option);
}

function resolveTextModelOption(options: TextModelOption[], selection: TextModelSelection): TextModelOption {
  return options.find((option) => sameTextModel(option, selection)) ?? options[0] ?? DEFAULT_TEXT_MODEL_OPTIONS[0]!;
}

function imageModelSelectionFromKey(key: string, options: ImageModelOption[]): ImageModelSelection {
  const option =
    options.find((candidate) => imageModelKey(candidate) === key) ?? options[0] ?? DEFAULT_IMAGE_MODEL_OPTIONS[0]!;
  return imageModelSelectionFromOption(option);
}

function resolveImageModelOption(options: ImageModelOption[], selection: ImageModelSelection): ImageModelOption {
  return options.find((option) => sameImageModel(option, selection)) ?? options[0] ?? DEFAULT_IMAGE_MODEL_OPTIONS[0]!;
}

function imageModelLabel(option: ImageModelOption): string {
  return option.costUsd === undefined ? option.label : `${option.label} — ${formatUsd(option.costUsd)}/image`;
}

function textModelLabel(option: TextModelOption): string {
  return option.thinking ? `${option.label} (Thinking)` : option.label;
}

function sameTextModel(first: TextModelSelection, second: TextModelSelection): boolean {
  return (
    first.provider === second.provider &&
    first.model === second.model &&
    first.thinkingBudget === second.thinkingBudget &&
    first.thinkingEnabled === second.thinkingEnabled
  );
}

function sameImageModel(first: ImageModelSelection, second: ImageModelSelection): boolean {
  return first.provider === second.provider && first.model === second.model;
}

function textModelKey(selection: TextModelSelection): string {
  return `${selection.provider}:${selection.model}:${selection.thinkingBudget ?? "default"}:${
    selection.thinkingEnabled ?? "default"
  }`;
}

function imageModelKey(selection: ImageModelSelection): string {
  return `${selection.provider}:${selection.model}`;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return false;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveGenerationStrategy(
  strategies: GenerationStrategyOption[],
  strategyId: string
): GenerationStrategyOption {
  return (
    strategies.find((strategy) => strategy.id === strategyId) ??
    DEFAULT_GENERATION_STRATEGIES.find((strategy) => strategy.id === strategyId) ?? {
      id: strategyId,
      label: formatStrategyLabel(strategyId),
      strengthScore: 0,
      recommendedPageRange: { min: 5, max: 20 }
    }
  );
}

function formatRecommendedPageRange(range?: GenerationStrategyOption["recommendedPageRange"]): string {
  const fallbackRange = DEFAULT_GENERATION_STRATEGIES[1]?.recommendedPageRange ?? { min: 5, max: 20 };
  const pageRange = range ?? fallbackRange;
  const min = Math.max(1, Math.round(pageRange.min));
  const max = Math.max(min, Math.round(pageRange.max));
  return `${min}-${max}`;
}

function formatStrategyLabel(strategyId: string): string {
  return strategyId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function PlanQuestionStepper(props: {
  questions: NormalizedPlanQuestion[];
  responses: Record<string, QuestionResponse>;
  activeIndex: number;
  customAnswer: string;
  busy: boolean;
  revisionPending: boolean;
  responsesSubmitted: boolean;
  onAnswer: (answer: string) => void;
  onCustomAnswerChange: (answer: string) => void;
  onGoTo: (index: number) => void;
  onSkip: () => void;
  onSubmit: () => void;
}) {
  if (props.questions.length === 0) {
    return null;
  }

  const activeIndex = Math.min(props.activeIndex, props.questions.length - 1);
  const activeQuestion = props.questions[activeIndex]!;
  const activeResponse = props.responses[activeQuestion.id];
  const responseCount = props.questions.filter((question) => props.responses[question.id]).length;
  const answeredCount = props.questions.filter((question) => props.responses[question.id]?.status === "answered").length;
  const skippedCount = props.questions.filter((question) => props.responses[question.id]?.status === "skipped").length;
  const controlsBusy = props.busy || props.revisionPending;
  const submitLabel = props.revisionPending ? "Applying" : props.responsesSubmitted ? "Submitted" : "Apply";

  return (
    <section className="plan-question-stepper" aria-label="Plan questions">
      <div className="question-stepper-header">
        <h4>Plan questions</h4>
        <span>
          {answeredCount} answered / {skippedCount} skipped
        </span>
      </div>
      <div className="question-steps" role="tablist" aria-label="Plan question steps">
        {props.questions.map((question, index) => {
          const response = props.responses[question.id];
          return (
            <button
              key={question.id}
              type="button"
              className={`question-step${index === activeIndex ? " active" : ""}${response ? ` ${response.status}` : ""}`}
              onClick={() => props.onGoTo(index)}
              aria-label={`Question ${index + 1}`}
              aria-selected={index === activeIndex}
            >
              {response?.status === "answered" ? (
                <CheckCircle2 size={14} />
              ) : response?.status === "skipped" ? (
                <SkipForward size={14} />
              ) : (
                <span>{index + 1}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="question-card">
        <div className="question-card-heading">
          <small>
            Question {activeIndex + 1} of {props.questions.length}
          </small>
          {activeResponse ? <span className={`question-state ${activeResponse.status}`}>{activeResponse.status}</span> : null}
        </div>
        <p>{activeQuestion.prompt}</p>
        {activeQuestion.options.length > 0 ? (
          <div className="answer-options">
            {activeQuestion.options.map((option) => (
              <button
                key={option}
                type="button"
                className={
                  activeResponse?.status === "answered" && activeResponse.answer === option
                    ? "answer-option selected"
                    : "answer-option"
                }
                onClick={() => props.onAnswer(option)}
                disabled={controlsBusy}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
        {activeQuestion.allowCustom ? (
          <label className="custom-answer">
            Custom answer
            <textarea
              rows={3}
              value={props.customAnswer}
              onChange={(event) => props.onCustomAnswerChange(event.target.value)}
              placeholder="Type a custom answer"
              disabled={controlsBusy}
            />
          </label>
        ) : null}
        <div className="question-actions">
          <button
            className="icon-button"
            type="button"
            onClick={() => props.onGoTo(activeIndex - 1)}
            disabled={activeIndex === 0 || controlsBusy}
            title="Previous question"
          >
            <ChevronLeft size={16} />
          </button>
          <button className="icon-text-button" type="button" onClick={props.onSkip} disabled={controlsBusy}>
            <SkipForward size={16} />
            Skip
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => props.onGoTo(activeIndex + 1)}
            disabled={activeIndex === props.questions.length - 1 || controlsBusy}
            title="Next question"
          >
            <ChevronRight size={16} />
          </button>
          {activeQuestion.allowCustom ? (
            <button
              className="primary-button compact"
              type="button"
              onClick={() => props.onAnswer(props.customAnswer)}
              disabled={controlsBusy || !props.customAnswer.trim()}
            >
              <Send size={16} />
              Answer
            </button>
          ) : null}
          <button
            className="icon-text-button accent"
            type="button"
            onClick={props.onSubmit}
            disabled={controlsBusy || props.responsesSubmitted || responseCount === 0}
          >
            {props.revisionPending ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
            {submitLabel}
          </button>
        </div>
      </div>
    </section>
  );
}

function PipelineStepItem(props: { step: PipelineStep; isLast: boolean }) {
  const icon =
    props.step.status === "active" ? (
      <Loader2 className="spin pipeline-icon" size={14} />
    ) : props.step.status === "done" ? (
      <CheckCircle2 className="pipeline-icon done" size={14} />
    ) : props.step.status === "failed" ? (
      <XCircle className="pipeline-icon failed" size={14} />
    ) : (
      <Circle className="pipeline-icon pending" size={14} />
    );

  return (
    <div className={`pipeline-step status-${props.step.status}${props.isLast ? " last" : ""}`}>
      {icon}
      <div className="pipeline-step-body">
        <strong>{props.step.label}</strong>
        {props.step.detail ? <small>{props.step.detail}</small> : null}
      </div>
    </div>
  );
}

function JobRow(props: { job: GenerationJobRow }) {
  const { job } = props;
  const steps = resolveJobDisplaySteps(job);
  const statusClass = job.status.toLowerCase();

  return (
    <div className={`job-row status-${statusClass}`}>
      <div className="job-row-header">
        <div className="job-title">
          {job.type === "GENERATE_PAGE" && typeof job.pageIndex === "number" ? (
            <span className="job-page-badge" title={`Page ${job.pageIndex}`} aria-label={`Page ${job.pageIndex}`}>
              {job.pageIndex}
            </span>
          ) : null}
          <span className="job-type">{job.type}</span>
        </div>
        <span className={`job-status-pill status-${statusClass}`}>
          {job.status === "ACTIVE" ? <Loader2 className="spin" size={12} /> : null}
          {job.status}
        </span>
      </div>
      <div className="job-progress-bar">
        <div style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }} />
      </div>
      <small className="job-message">{job.error ?? job.message ?? `${job.progress}%`}</small>
      <small className="job-token-usage">{formatTokenPair(job.tokens)}</small>
      {hasProviderDuration(job.providerDurationMs) ? (
        <small className="job-provider-duration">Provider {formatDuration(job.providerDurationMs)}</small>
      ) : null}
      {job.startedAt || job.finishedAt ? (
        <small className="job-timing">{formatJobTiming(job.startedAt, job.finishedAt)}</small>
      ) : null}
      {steps.length > 0 ? (
        <ul className={`job-steps${job.status === "ACTIVE" ? " expanded" : ""}`}>
          {steps.map((step) => (
            <JobStepItem key={step.key} step={step} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function JobStepItem(props: { step: JobStep }) {
  const icon =
    props.step.status === "active" ? (
      <Loader2 className="spin" size={12} />
    ) : props.step.status === "done" ? (
      <CheckCircle2 size={12} />
    ) : props.step.status === "failed" ? (
      <XCircle size={12} />
    ) : (
      <Circle size={12} />
    );

  return (
    <li className={`job-step status-${props.step.status}`}>
      {icon}
      <span>{props.step.label}</span>
    </li>
  );
}

function formatTokenPair(tokens?: TokenUsage | null): string {
  return `Input ${formatTokenCount(tokens?.promptTokens)} · Output ${formatTokenCount(tokens?.outputTokens)}`;
}

function hasProviderDuration(value?: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function formatDuration(milliseconds?: number | null): string {
  const totalSeconds = Math.max(0, Math.round((milliseconds ?? 0) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatProjectCost(cost?: ProjectCost | null): string {
  return `Text ${formatUsd(cost?.textUsd)} · Image ${formatUsd(cost?.imageUsd)}`;
}

function formatUsd(value?: number | null): string {
  const safeValue = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  if (safeValue > 0 && safeValue < 0.01) {
    return PRECISE_USD_FORMATTER.format(safeValue);
  }
  return USD_FORMATTER.format(safeValue);
}

function projectPopoverPoint(clientX: number, clientY: number): { x: number; y: number } {
  const offset = 14;
  const popoverWidth = 260;
  const popoverHeight = 238;
  const viewportPadding = 8;

  return {
    x: Math.max(viewportPadding, Math.min(clientX + offset, window.innerWidth - popoverWidth - viewportPadding)),
    y: Math.max(viewportPadding, Math.min(clientY + offset, window.innerHeight - popoverHeight - viewportPadding))
  };
}

function projectStrategyLabel(project: Project, strategies: GenerationStrategyOption[]): string {
  const strategyId = project.mediaSettings?.generationStrategy ?? DEFAULT_GENERATION_STRATEGY_ID;
  return resolveGenerationStrategy(strategies, strategyId).label;
}

function projectToneLabel(project: Project): string {
  const toneProfile = toneProfileFromValue(project.mediaSettings?.toneProfile ?? DEFAULT_TONE_PROFILE);
  return TONE_PROFILE_OPTIONS.find((tone) => tone.id === toneProfile)?.label ?? formatStrategyLabel(toneProfile);
}

function formatProjectAiModels(
  project: Project,
  textModelOptions: TextModelOption[],
  imageModelOptions: ImageModelOption[]
): string {
  const labels = [`Text ${projectTextModelLabel(project, textModelOptions)}`];
  if (projectUsesImageModel(project)) {
    labels.push(`Image ${projectImageModelLabel(project, imageModelOptions)}`);
  }
  return labels.join(" · ");
}

function projectTextModelLabel(project: Project, options: TextModelOption[]): string {
  const mediaSettings = projectSavedMediaSettings(project);
  const selection = mediaSettings.textModel
    ? textModelSelectionFromValue(mediaSettings.textModel)
    : options[0]
      ? textModelSelectionFromOption(options[0])
      : DEFAULT_TEXT_MODEL;
  const option = options.find((candidate) => sameTextModel(candidate, selection));
  return option ? textModelLabel(option) : modelSelectionLabel(selection);
}

function projectImageModelLabel(project: Project, options: ImageModelOption[]): string {
  const mediaSettings = projectSavedMediaSettings(project);
  const selection = mediaSettings.imageModel
    ? imageModelSelectionFromValue(mediaSettings.imageModel)
    : options[0]
      ? imageModelSelectionFromOption(options[0])
      : DEFAULT_IMAGE_MODEL;
  const option = options.find((candidate) => sameImageModel(candidate, selection));
  return option?.label ?? modelSelectionLabel(selection);
}

function projectUsesImageModel(project: Project): boolean {
  const mediaSettings = projectSavedMediaSettings(project);
  const fullIllustrations =
    typeof mediaSettings.fullIllustrations === "boolean"
      ? mediaSettings.fullIllustrations
      : initialDraft.fullIllustrations;
  const includeCover =
    typeof mediaSettings.includeCover === "boolean"
      ? mediaSettings.includeCover
      : initialDraft.includeCover;
  return fullIllustrations || includeCover;
}

function projectSavedMediaSettings(project: Project): NonNullable<Project["mediaSettings"]> {
  return {
    ...(project.mediaSettings ?? {}),
    ...(project.currentPlan?.inputSnapshot?.mediaSettings ?? {})
  };
}

function modelSelectionLabel(selection: TextModelSelection | ImageModelSelection): string {
  if ("thinkingEnabled" in selection && selection.provider === "deepseek" && selection.thinkingEnabled) {
    return `${modelProviderLabel(selection.provider)} ${selection.model} (Thinking)`;
  }
  if ("thinkingBudget" in selection && selection.provider === "gemini" && selection.thinkingBudget === 0) {
    return `${modelProviderLabel(selection.provider)} ${selection.model} (No Thinking)`;
  }
  return `${modelProviderLabel(selection.provider)} ${selection.model}`;
}

function modelProviderLabel(provider: TextModelSelection["provider"] | ImageModelSelection["provider"]): string {
  if (provider === "deepseek") {
    return "DeepSeek";
  }
  if (provider === "gemini") {
    return "Gemini";
  }
  return "Alibaba";
}

function formatProjectPages(project: Project): string {
  const pageCount = project._count?.pages;
  return typeof pageCount === "number" ? `${pageCount}/${project.targetPages}` : `${project.targetPages}`;
}

function formatTokenCount(value?: number | null): string {
  return TOKEN_FORMATTER.format(typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0);
}

function formatJobTiming(startedAt?: string | null, finishedAt?: string | null): string {
  if (finishedAt) {
    return `Finished ${formatRelativeTime(finishedAt)}`;
  }
  if (startedAt) {
    return `Started ${formatRelativeTime(startedAt)}`;
  }
  return "";
}

function formatRelativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const seconds = Math.max(0, Math.floor(delta / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function readError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Something went wrong.";
  }
  try {
    const parsed = JSON.parse(error.message) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    /* plain text error */
  }
  return error.message;
}

function normalizePlanMessages(messages: unknown): Array<{ role: string; content: string; at?: string }> {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }
    const record = message as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) {
      return [];
    }
    const normalized = {
      role: typeof record.role === "string" ? record.role : "user",
      content
    };
    return typeof record.at === "string" ? [{ ...normalized, at: record.at }] : [normalized];
  });
}

function normalizePlanQuestions(questions: unknown): NormalizedPlanQuestion[] {
  if (!Array.isArray(questions)) {
    return [];
  }

  return questions.flatMap((question, index) => {
    const normalized = normalizePlanQuestion(question, index);
    return normalized ? [normalized] : [];
  });
}

function normalizePlanQuestion(question: unknown, index: number): NormalizedPlanQuestion | null {
  if (typeof question === "string") {
    const prompt = question.trim();
    return prompt ? makeNormalizedPlanQuestion(index, prompt, [], true) : null;
  }
  if (!question || typeof question !== "object" || Array.isArray(question)) {
    return null;
  }

  const record = question as Record<string, unknown>;
  const prompt = firstString(record.prompt, record.question, record.text);
  if (!prompt) {
    return null;
  }

  const options = firstStringArray(
    record.options,
    record.suggestedAnswers,
    record.answers,
    record.choices,
    record.premadeAnswers
  );
  const allowCustom = typeof record.allowCustom === "boolean" ? record.allowCustom : true;
  return makeNormalizedPlanQuestion(index, prompt, options, allowCustom);
}

function makeNormalizedPlanQuestion(
  index: number,
  prompt: string,
  options: string[],
  allowCustom: boolean
): NormalizedPlanQuestion {
  return {
    id: `${index}-${prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}`,
    prompt,
    options: [...new Set(options.map((option) => option.trim()).filter(Boolean))],
    allowCustom
  };
}

function pruneQuestionResponses(
  questions: NormalizedPlanQuestion[],
  responses: Record<string, QuestionResponse>
): Record<string, QuestionResponse> {
  const questionIds = new Set(questions.map((question) => question.id));
  const entries = Object.entries(responses).filter(([questionId]) => questionIds.has(questionId));
  return entries.length === Object.keys(responses).length ? responses : Object.fromEntries(entries);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function formatProjectCategory(category: string, subcategory?: string | null): string {
  const categoryLabel =
    category in CATEGORY_LABELS ? CATEGORY_LABELS[category as ProjectCategory] : category;
  const trimmedSubcategory = subcategory?.trim();
  return trimmedSubcategory ? `${categoryLabel} / ${trimmedSubcategory}` : categoryLabel;
}

function firstStringArray(...values: unknown[]): string[] {
  for (const value of values) {
    const strings = normalizeStringArray(value);
    if (strings.length > 0) {
      return strings;
    }
  }
  return [];
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) {
      return [item.trim()];
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const label = firstString(record.label, record.value, record.text, record.answer);
      return label ? [label] : [];
    }
    return [];
  });
}

function buildQuestionResponseMessage(
  questions: NormalizedPlanQuestion[],
  responses: Record<string, QuestionResponse>
): string {
  const answered = questions
    .map((question) => ({ question, response: responses[question.id] }))
    .filter((entry): entry is { question: NormalizedPlanQuestion; response: QuestionResponse & { answer: string } } =>
      entry.response?.status === "answered" && Boolean(entry.response.answer?.trim())
    );
  const skipped = questions.filter((question) => responses[question.id]?.status === "skipped");

  return [
    "Planning question responses:",
    ...answered.map((entry, index) => `${index + 1}. ${entry.question.prompt}\nAnswer: ${entry.response.answer}`),
    ...(skipped.length > 0
      ? ["Skipped questions with no preference:", ...skipped.map((question) => `- ${question.prompt}`)]
      : [])
  ].join("\n");
}

import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiGet,
  apiPost,
  apiUrl,
  subscribeProjectEvents,
  type CreateVoiceConversationRequest,
  type Project,
  type ProjectDetails,
  type ProjectPdfStatus,
  type ProjectStatus,
  type RuntimeInfo,
  type Template,
  type VoiceCharacter,
  type VoiceConversation
} from "../../api.js";
import { normalizeProjectStatus } from "../../jobsDisplay.js";
import { readError } from "../shared/formatters.js";
import { VOICE_CHARACTER_JOB_TYPES } from "./actionKeys.js";
import { projectIdFromCurrentPath, SELECTED_PROJECT_STORAGE_KEY, syncProjectPath } from "./routing.js";

export function useProjectConsoleData(args: { authenticated: boolean | undefined }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => projectIdFromCurrentPath());
  const [detailsByProjectId, setDetailsByProjectId] = useState<Record<string, ProjectDetails>>({});
  const [statusByProjectId, setStatusByProjectId] = useState<Record<string, ProjectStatus>>({});
  const [bookMarkdownByProjectId, setBookMarkdownByProjectId] = useState<Record<string, string>>({});
  const [pdfAvailableByProjectId, setPdfAvailableByProjectId] = useState<Record<string, boolean>>({});
  const [voiceCharactersByProjectId, setVoiceCharactersByProjectId] = useState<Record<string, VoiceCharacter[]>>({});
  const [voiceConversationsByProjectId, setVoiceConversationsByProjectId] = useState<Record<string, VoiceConversation[]>>({});
  const [error, setError] = useState<string | null>(null);
  const lastPageCompleteByProjectIdRef = useRef<Record<string, number>>({});
  const lastVoiceCharacterJobsByProjectIdRef = useRef<Record<string, string>>({});

  const selectedDetails = selectedId ? detailsByProjectId[selectedId] ?? null : null;
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? selectedDetails,
    [projects, selectedId, selectedDetails]
  );
  const selectedBookMarkdown = selectedId ? bookMarkdownByProjectId[selectedId] ?? "" : "";
  const selectedPdfAvailable = selectedId ? pdfAvailableByProjectId[selectedId] ?? false : false;
  const selectedVoiceCharacters = selectedId ? voiceCharactersByProjectId[selectedId] ?? [] : [];
  const selectedVoiceConversations = selectedId ? voiceConversationsByProjectId[selectedId] ?? [] : [];
  const selectedPdfPreviewUrl = selectedProject
    ? apiUrl(`/api/projects/${selectedProject.id}/export/pdf?disposition=inline#toolbar=1&navpanes=0`)
    : "";

  useEffect(() => {
    const handlePopState = () => setSelectedId(projectIdFromCurrentPath());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (args.authenticated) {
      void refreshAll();
    }
  }, [args.authenticated]);

  useEffect(() => {
    if (!selectedId) {
      syncProjectPath(null);
      return;
    }
    syncProjectPath(selectedId);
    localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, selectedId);
    if (!args.authenticated) {
      return;
    }
    void refreshProject(selectedId);
    const detailsTimer = setInterval(() => void refreshProject(selectedId), 6000);
    return () => clearInterval(detailsTimer);
  }, [args.authenticated, selectedId]);

  useEffect(() => {
    if (!selectedId || !args.authenticated) {
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
        const voiceJobsSignature = voiceCharacterJobsSignature(normalizedStatus);
        if (
          voiceJobsSignature &&
          voiceJobsSignature !== (lastVoiceCharacterJobsByProjectIdRef.current[selectedId] ?? "")
        ) {
          lastVoiceCharacterJobsByProjectIdRef.current[selectedId] = voiceJobsSignature;
          void refreshVoiceCharacters(selectedId);
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
  }, [args.authenticated, selectedId]);

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
        clearProjectData();
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

  function clearProjectData() {
    setProjects([]);
    setSelectedId(null);
    setDetailsByProjectId({});
    setStatusByProjectId({});
    setBookMarkdownByProjectId({});
    setPdfAvailableByProjectId({});
    setVoiceCharactersByProjectId({});
    setVoiceConversationsByProjectId({});
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

  async function refreshProjectPdfPreview(id: string) {
    try {
      const status = await apiGet<ProjectPdfStatus>(`/api/projects/${id}/export/pdf/status`);
      setPdfAvailableByProjectId((current) => ({ ...current, [id]: status.available }));
    } catch {
      setPdfAvailableByProjectId((current) => ({ ...current, [id]: false }));
    }
  }

  async function refreshVoiceCharacters(id: string) {
    try {
      const characters = await apiGet<VoiceCharacter[]>(`/api/projects/${id}/voice-characters`);
      setVoiceCharactersByProjectId((current) => ({ ...current, [id]: characters }));
    } catch {
      setVoiceCharactersByProjectId((current) => ({ ...current, [id]: [] }));
    }
  }

  async function refreshVoiceConversations(id: string) {
    try {
      const conversations = await apiGet<VoiceConversation[]>(`/api/projects/${id}/voice-conversations`);
      setVoiceConversationsByProjectId((current) => ({ ...current, [id]: conversations }));
    } catch {
      setVoiceConversationsByProjectId((current) => ({ ...current, [id]: [] }));
    }
  }

  async function createVoiceConversation(
    projectId: string,
    payload: CreateVoiceConversationRequest
  ): Promise<VoiceConversation> {
    try {
      setError(null);
      const conversation = await apiPost<VoiceConversation>(`/api/projects/${projectId}/voice-conversations`, payload);
      setVoiceConversationsByProjectId((current) => ({
        ...current,
        [projectId]: [conversation, ...(current[projectId] ?? []).filter((candidate) => candidate.id !== conversation.id)]
      }));
      return conversation;
    } catch (createError) {
      const message = readError(createError);
      setError(message);
      throw createError;
    }
  }

  async function refreshProject(id: string) {
    await Promise.all([
      refreshProjectDetails(id),
      refreshBookMarkdown(id),
      refreshProjectPdfPreview(id),
      refreshVoiceCharacters(id),
      refreshVoiceConversations(id)
    ]);
    try {
      const statusData = cacheProjectStatus(await apiGet<ProjectStatus>(`/api/projects/${id}/status`));
      lastPageCompleteByProjectIdRef.current[id] = statusData.progress.pages.complete;
    } catch (refreshError) {
      setError(readError(refreshError));
    }
  }

  return {
    templates,
    projects,
    runtime,
    selectedId,
    setSelectedId,
    selectedDetails,
    selectedProject,
    selectedBookMarkdown,
    selectedPdfAvailable,
    selectedPdfPreviewUrl,
    selectedVoiceCharacters,
    selectedVoiceConversations,
    selectedStatus: selectedId ? statusByProjectId[selectedId] ?? null : null,
    error,
    setError,
    refreshAll,
    refreshProject,
    refreshVoiceCharacters,
    refreshVoiceConversations,
    createVoiceConversation,
    clearProjectData
  };
}

function voiceCharacterJobsSignature(status: ProjectStatus): string {
  return status.project.jobs
    .filter((job) => VOICE_CHARACTER_JOB_TYPES.has(job.type))
    .map((job) => `${job.id}:${job.status}:${job.progress}:${job.message ?? ""}:${job.finishedAt ?? ""}`)
    .join("|");
}

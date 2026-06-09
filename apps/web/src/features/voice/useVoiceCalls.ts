import { useEffect, useState } from "react";
import { apiGet, type VoiceCharacter, type VoiceChatProviderId, type VoiceModelOption, type VoiceProviderInfo } from "../../api.js";
import { readError } from "../shared/formatters.js";
import { createBrowserVoiceCallClient } from "./BrowserVoiceCallClient.js";
import type { ActiveVoiceCall } from "./types.js";

const VOICE_PROVIDER_STORAGE_KEY = "ai-book-maker.voiceProvider";
const VOICE_MODEL_STORAGE_KEY = "ai-book-maker.voiceModels";

export function useVoiceCalls(
  setError: (error: string | null) => void,
  options: { authenticated?: boolean | undefined } = {}
) {
  const [activeVoiceCall, setActiveVoiceCall] = useState<ActiveVoiceCall>(null);
  const [voiceProviders, setVoiceProviders] = useState<VoiceProviderInfo[]>([]);
  const [selectedVoiceProviderId, setSelectedVoiceProviderIdState] = useState<VoiceChatProviderId>(() =>
    storedVoiceProviderId() ?? "gemini_live"
  );
  const [selectedVoiceModels, setSelectedVoiceModels] = useState<Partial<Record<VoiceChatProviderId, string>>>(() =>
    storedVoiceModels()
  );

  useEffect(() => {
    if (!options.authenticated) {
      setVoiceProviders([]);
      return;
    }
    let cancelled = false;
    void apiGet<VoiceProviderInfo[]>("/api/voice/providers")
      .then((providers) => {
        if (cancelled) {
          return;
        }
        setVoiceProviders(providers);
        const stored = storedVoiceProviderId();
        const defaultProvider = providers.find((provider) => provider.default) ?? providers[0];
        const nextProvider =
          (stored && providers.some((provider) => provider.id === stored) ? stored : null) ??
          defaultProvider?.id ??
          "gemini_live";
        setSelectedVoiceProviderIdState(nextProvider);
        setSelectedVoiceModels((current) => normalizeStoredVoiceModels(providers, current));
      })
      .catch((error) => {
        if (!cancelled) {
          setError(readError(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [options.authenticated, setError]);

  const selectedVoiceProvider =
    voiceProviders.find((provider) => provider.id === selectedVoiceProviderId) ??
    voiceProviders.find((provider) => provider.default) ??
    voiceProviders[0] ??
    null;
  const selectedVoiceModel = selectedVoiceProvider
    ? resolveVoiceModel(selectedVoiceProvider, selectedVoiceModels[selectedVoiceProvider.id])
    : null;

  function setSelectedVoiceProviderId(providerId: VoiceChatProviderId) {
    if (activeVoiceCall) {
      return;
    }
    setSelectedVoiceProviderIdState(providerId);
    localStorage.setItem(VOICE_PROVIDER_STORAGE_KEY, providerId);
  }

  function setSelectedVoiceModel(model: string) {
    if (activeVoiceCall || !selectedVoiceProvider) {
      return;
    }
    const normalized = model.trim();
    if (!selectedVoiceProvider.modelOptions.some((option) => option.model === normalized)) {
      return;
    }
    setSelectedVoiceModels((current) => {
      const next = { ...current, [selectedVoiceProvider.id]: normalized };
      localStorage.setItem(VOICE_MODEL_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function startVoiceCall(character: VoiceCharacter) {
    const provider = selectedVoiceProvider;
    if (!provider) {
      setError("No voice provider is available.");
      return;
    }
    if (!provider.configured) {
      setError(`${provider.label} is not configured.`);
      return;
    }

    await endVoiceCall();
    const client = createBrowserVoiceCallClient(provider.id, character.id, {
      voiceModel: selectedVoiceModel ?? provider.model,
      onStatusChange: (status) => {
        setActiveVoiceCall((current) => {
          if (current?.client !== client) {
            return current;
          }
          if (status === "connected") {
            const { error: _error, ...connectedCall } = current;
            return { ...connectedCall, status };
          }
          return { ...current, status };
        });
      },
      onFailure: (failureError) => {
        const message = readError(failureError);
        setActiveVoiceCall((current) =>
          current?.client === client
            ? { ...current, client: null, status: "failed", muted: false, error: message }
            : current
        );
        setError(message);
      }
    });
    setActiveVoiceCall({
      character,
      provider,
      voiceModel: selectedVoiceModel ?? provider.model,
      client,
      status: "connecting",
      muted: false
    });
    try {
      await client.connect();
      setActiveVoiceCall((current) => {
        if (current?.client !== client) {
          return current;
        }
        const { error: _error, ...connectedCall } = current;
        return { ...connectedCall, status: "connected" };
      });
    } catch (callError) {
      const endedByUser = client.isEnded();
      await client.end();
      if (endedByUser) {
        return;
      }
      setActiveVoiceCall({
        character,
        provider,
        voiceModel: selectedVoiceModel ?? provider.model,
        client: null,
        status: "failed",
        muted: false,
        error: readError(callError)
      });
      setError(readError(callError));
    }
  }

  async function endVoiceCall() {
    const call = activeVoiceCall;
    if (call?.client) {
      await call.client.end();
    }
    setActiveVoiceCall(null);
  }

  function toggleVoiceCallMute() {
    setActiveVoiceCall((current) => {
      if (!current?.client) {
        return current;
      }
      const muted = !current.muted;
      current.client.setMuted(muted);
      return { ...current, muted };
    });
  }

  return {
    activeVoiceCall,
    voiceProviders,
    selectedVoiceProvider,
    selectedVoiceProviderId,
    selectedVoiceModel,
    setSelectedVoiceProviderId,
    setSelectedVoiceModel,
    startVoiceCall,
    endVoiceCall,
    toggleVoiceCallMute
  };
}

function storedVoiceProviderId(): VoiceChatProviderId | null {
  const stored = localStorage.getItem(VOICE_PROVIDER_STORAGE_KEY);
  return stored === "openai_realtime" || stored === "gemini_live" ? stored : null;
}

function storedVoiceModels(): Partial<Record<VoiceChatProviderId, string>> {
  const stored = localStorage.getItem(VOICE_MODEL_STORAGE_KEY);
  if (!stored) {
    return {};
  }
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    return {
      ...(typeof parsed.openai_realtime === "string" ? { openai_realtime: parsed.openai_realtime } : {}),
      ...(typeof parsed.gemini_live === "string" ? { gemini_live: parsed.gemini_live } : {})
    };
  } catch {
    return {};
  }
}

function normalizeStoredVoiceModels(
  providers: VoiceProviderInfo[],
  stored: Partial<Record<VoiceChatProviderId, string>>
): Partial<Record<VoiceChatProviderId, string>> {
  const next: Partial<Record<VoiceChatProviderId, string>> = {};
  for (const provider of providers) {
    next[provider.id] = resolveVoiceModel(provider, stored[provider.id]);
  }
  localStorage.setItem(VOICE_MODEL_STORAGE_KEY, JSON.stringify(next));
  return next;
}

function resolveVoiceModel(provider: VoiceProviderInfo, storedModel: string | undefined): string {
  if (storedModel && provider.modelOptions.some((option) => option.model === storedModel)) {
    return storedModel;
  }
  return defaultVoiceModelOption(provider.modelOptions)?.model ?? provider.model;
}

function defaultVoiceModelOption(options: VoiceModelOption[]): VoiceModelOption | undefined {
  return options.find((option) => option.default) ?? options[0];
}

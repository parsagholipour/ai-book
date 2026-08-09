import { useEffect, useMemo, useState } from "react";
import {
  FileAudio,
  MessageSquareText,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Sparkles,
  Users,
  XCircle
} from "lucide-react";
import {
  apiUrl,
  type CreateVoiceConversationRequest,
  type VoiceAgeBand,
  type VoiceCharacter,
  type VoiceChatProviderId,
  type VoiceConversation,
  type VoiceGenderPresentation,
  type VoiceModelOption,
  type VoiceProfile,
  type VoiceProviderInfo,
  type ProjectStatus
} from "../../api.js";
import { voiceCharacterActionKey } from "../projects/actionKeys.js";
import { Button, IconButton } from "../shared/Button.js";
import { formatDuration, formatRelativeTime, initialsForName, labelCase, readError } from "../shared/formatters.js";
import {
  VOICE_AGE_BAND_OPTIONS,
  VOICE_FORMALITY_OPTIONS,
  VOICE_GENDER_OPTIONS,
  VOICE_INTENSITY_OPTIONS,
  VOICE_PACE_OPTIONS
} from "./constants.js";
import type { ActiveVoiceCall, ActiveVoiceCallStatus, ActiveVoiceRoom } from "./types.js";

export function VoiceCharactersPanel(props: {
  characters: VoiceCharacter[];
  selectedStatus: ProjectStatus | null;
  busyActions: Record<string, boolean>;
  conversations: VoiceConversation[];
  activeCallCharacterId: string | null;
  activeRoomCharacterIds: string[];
  providers: VoiceProviderInfo[];
  selectedProviderId: VoiceChatProviderId;
  selectedModel: string | null;
  providerSelectionDisabled: boolean;
  onApprove: (character: VoiceCharacter) => void;
  onReject: (character: VoiceCharacter) => void;
  onProfileChange: (character: VoiceCharacter, patch: Partial<VoiceProfile>) => void;
  onProviderChange: (providerId: VoiceChatProviderId) => void;
  onModelChange: (model: string) => void;
  onCall: (character: VoiceCharacter) => void;
  onStartRoom: (characters: VoiceCharacter[]) => void;
  onCreateConversation: (payload: CreateVoiceConversationRequest) => Promise<VoiceConversation>;
}) {
  const [selectedRoomCharacterIds, setSelectedRoomCharacterIds] = useState<string[]>([]);
  const [conversationDialogOpen, setConversationDialogOpen] = useState(false);
  const [conversationContinuationTarget, setConversationContinuationTarget] = useState<VoiceConversation | null>(null);
  const [conversationPrompt, setConversationPrompt] = useState("");
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [latestConversationId, setLatestConversationId] = useState<string | null>(null);
  const readyCount = props.characters.filter((character) => character.status === "READY").length;
  const readyCharacters = useMemo(
    () => props.characters.filter((character) => character.status === "READY"),
    [props.characters]
  );
  const selectedProvider = props.providers.find((provider) => provider.id === props.selectedProviderId) ?? props.providers[0] ?? null;
  const selectedModel = props.selectedModel ?? selectedProvider?.model ?? null;
  const geminiConfigured = props.providers.some((provider) => provider.id === "gemini_live" && provider.configured);
  const activeRoomCharacterIds = new Set(props.activeRoomCharacterIds);
  const activeRoom = props.activeRoomCharacterIds.length > 0;
  const activeCall = Boolean(props.activeCallCharacterId);
  const selectedRoomCharacters = readyCharacters.filter((character) => selectedRoomCharacterIds.includes(character.id));
  const canStartRoom =
    selectedRoomCharacters.length >= 2 &&
    selectedRoomCharacters.length <= 4 &&
    Boolean(selectedProvider?.configured && selectedModel) &&
    !props.activeCallCharacterId &&
    !activeRoom;
  const canMakeConversation =
    selectedRoomCharacters.length === 2 &&
    geminiConfigured &&
    !props.activeCallCharacterId &&
    !activeRoom &&
    !creatingConversation;
  const canContinueConversation = geminiConfigured && !props.activeCallCharacterId && !activeRoom && !creatingConversation;
  const statusLabel =
    props.characters.length === 0
      ? ""
      : readyCount > 0
        ? `${readyCount}/${props.characters.length} ready`
      : `${props.characters.length} candidate${props.characters.length === 1 ? "" : "s"}`;

  useEffect(() => {
    const readyIds = new Set(readyCharacters.map((character) => character.id));
    setSelectedRoomCharacterIds((current) => current.filter((characterId) => readyIds.has(characterId)).slice(0, 4));
  }, [readyCharacters]);

  function toggleRoomCharacter(character: VoiceCharacter) {
    setSelectedRoomCharacterIds((current) => {
      if (current.includes(character.id)) {
        return current.filter((characterId) => characterId !== character.id);
      }
      return [...current, character.id].slice(0, 4);
    });
  }

  async function createConversation() {
    const prompt = conversationPrompt.trim();
    const canCreate = conversationContinuationTarget ? canContinueConversation : canMakeConversation;
    if (!prompt || !canCreate) {
      return;
    }
    setCreatingConversation(true);
    setConversationError(null);
    try {
      const payload: CreateVoiceConversationRequest = conversationContinuationTarget
        ? { prompt, continuationOfConversationId: conversationContinuationTarget.id }
        : { prompt, characterIds: selectedRoomCharacters.map((character) => character.id) };
      const conversation = await props.onCreateConversation(payload);
      setLatestConversationId(conversation.id);
      setConversationPrompt("");
      setConversationDialogOpen(false);
      setConversationContinuationTarget(null);
    } catch (error) {
      setConversationError(readError(error));
    } finally {
      setCreatingConversation(false);
    }
  }

  return (
    <div className="work-section voice-character-panel">
      <div className="section-title voice-character-title">
        <Phone size={18} />
        <h3>Character Chat</h3>
        {statusLabel ? <span className="section-count">{statusLabel}</span> : null}
      </div>
      {props.providers.length > 0 ? (
        <div className="voice-selection-stack">
          <VoiceProviderSelector
            providers={props.providers}
            selectedProviderId={props.selectedProviderId}
            disabled={props.providerSelectionDisabled}
            onChange={props.onProviderChange}
          />
          {selectedProvider && selectedProvider.configured && selectedProvider.modelOptions.length > 1 ? (
            <VoiceModelSelector
              models={selectedProvider.modelOptions}
              selectedModel={selectedModel ?? selectedProvider.model}
              disabled={props.providerSelectionDisabled}
              onChange={props.onModelChange}
            />
          ) : null}
        </div>
      ) : null}
      {props.characters.length === 0 ? (
        <p className="muted">No character chat candidates for this book.</p>
      ) : (
        <>
          {readyCharacters.length >= 2 ? (
            <div className="voice-room-builder">
              <div className="voice-room-header">
                <div>
                  <strong>Group voice</strong>
                  <small>{selectedRoomCharacters.length}/4 selected</small>
                </div>
                <Button
                  variant="accent"
                  size="sm"
                  disabled={!canStartRoom}
                  onClick={() => props.onStartRoom(selectedRoomCharacters)}
                  startIcon={<Users />}
                >
                  Start room
                </Button>
                <Button
                  size="sm"
                  disabled={!canMakeConversation}
                  loading={creatingConversation}
                  loadingLabel="Creating conversation…"
                  startIcon={<Sparkles />}
                  onClick={() => {
                    setConversationError(null);
                    setConversationContinuationTarget(null);
                    setConversationDialogOpen(true);
                  }}
                  title={geminiConfigured ? "Generate a saved scripted voice conversation" : "Gemini is not configured"}
                >
                  Make conversation
                </Button>
              </div>
              <div className="voice-room-picks">
                {readyCharacters.map((character) => {
                  const selected = selectedRoomCharacterIds.includes(character.id);
                  return (
                    <label key={character.id} className={`voice-room-pick${selected ? " selected" : ""}`}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={props.providerSelectionDisabled || (!selected && selectedRoomCharacterIds.length >= 4)}
                        onChange={() => toggleRoomCharacter(character)}
                      />
                      <span>{character.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
          {conversationDialogOpen ? (
            <VoiceConversationDialog
              title={conversationContinuationTarget ? "Continue conversation" : "Make conversation"}
              characters={conversationContinuationTarget?.characters ?? selectedRoomCharacters}
              prompt={conversationPrompt}
              error={conversationError}
              busy={creatingConversation}
              canSubmit={
                Boolean(conversationPrompt.trim()) &&
                (conversationContinuationTarget ? canContinueConversation : canMakeConversation)
              }
              onPromptChange={setConversationPrompt}
              onCancel={() => {
                if (!creatingConversation) {
                  setConversationDialogOpen(false);
                  setConversationContinuationTarget(null);
                  setConversationError(null);
                }
              }}
              onSubmit={() => void createConversation()}
            />
          ) : null}
          <VoiceConversationList
            conversations={props.conversations}
            latestConversationId={latestConversationId}
            continuationDisabled={!canContinueConversation}
            onContinue={(conversation) => {
              setConversationError(null);
              setConversationPrompt("");
              setConversationContinuationTarget(conversation);
              setConversationDialogOpen(true);
            }}
          />
          <div className="voice-character-list">
            {props.characters.map((character) => (
              <VoiceCharacterCard
                key={character.id}
                character={character}
                hasActivePersonaBuildJob={hasActivePersonaBuildJob(props.selectedStatus, character.id)}
                busyActions={props.busyActions}
                active={props.activeCallCharacterId === character.id}
                inRoom={activeRoomCharacterIds.has(character.id)}
                callDisabled={!selectedProvider?.configured || !selectedModel || activeRoom || activeCall}
                onApprove={props.onApprove}
                onReject={props.onReject}
                onProfileChange={props.onProfileChange}
                onCall={props.onCall}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function VoiceCharacterCard(props: {
  character: VoiceCharacter;
  hasActivePersonaBuildJob: boolean;
  busyActions: Record<string, boolean>;
  active: boolean;
  inRoom: boolean;
  callDisabled: boolean;
  onApprove: (character: VoiceCharacter) => void;
  onReject: (character: VoiceCharacter) => void;
  onProfileChange: (character: VoiceCharacter, patch: Partial<VoiceProfile>) => void;
  onCall: (character: VoiceCharacter) => void;
}) {
  const { character } = props;
  const approving = Boolean(props.busyActions[voiceCharacterActionKey(character.id, "approve")]);
  const rejecting = Boolean(props.busyActions[voiceCharacterActionKey(character.id, "reject")]);
  const editing = Boolean(props.busyActions[voiceCharacterActionKey(character.id, "voice-profile")]);
  const ready = character.status === "READY";
  const building = props.hasActivePersonaBuildJob || character.status === "APPROVED" || character.status === "BUILDING";
  const editable = !building && character.status !== "REJECTED";
  const needsBuild = character.status === "CANDIDATE" || character.status === "FAILED";
  const buildBusy = approving || building;

  return (
    <article className={`voice-character-card status-${character.status.toLowerCase()}`}>
      <div className="voice-character-main">
        <div className="voice-avatar">
          {character.profileImage ? (
            <img src={apiUrl(character.profileImage.path)} alt={character.name} />
          ) : (
            <span>{initialsForName(character.name)}</span>
          )}
        </div>
        <div>
          <div className="voice-character-heading">
            <h4>{character.name}</h4>
            <span className={`job-status-pill status-${character.status.toLowerCase()}`}>{character.status}</span>
          </div>
          <p>{character.role}</p>
          <small>{character.description}</small>
        </div>
      </div>
      {character.traits.length > 0 ? (
        <div className="voice-traits">
          {character.traits.slice(0, 5).map((trait) => (
            <span key={trait}>{trait}</span>
          ))}
        </div>
      ) : null}
      {character.error ? <small className="voice-character-error">{character.error}</small> : null}
      <div className="voice-character-actions">
        {needsBuild || building ? (
          <Button
            variant="accent"
            size="sm"
            onClick={() => props.onApprove(character)}
            disabled={buildBusy}
            loading={buildBusy}
            loadingLabel={building ? "Building chat" : "Starting build…"}
            startIcon={<MessageSquareText />}
          >
            {building ? "Building chat" : character.status === "FAILED" ? "Retry chat build" : "Build chat"}
          </Button>
        ) : null}
        {needsBuild ? (
          <Button
            variant="danger"
            size="sm"
            onClick={() => props.onReject(character)}
            disabled={rejecting || building}
            loading={rejecting}
            loadingLabel="Rejecting…"
            startIcon={<XCircle />}
          >
            Reject
          </Button>
        ) : null}
        {ready ? (
          <Button
            variant="primary"
            size="sm"
            compact
            onClick={() => props.onCall(character)}
            disabled={props.active || props.callDisabled}
            startIcon={<Phone />}
          >
            {props.active ? "In chat" : props.inRoom ? "In room" : "Voice chat"}
          </Button>
        ) : null}
      </div>
      <VoiceProfileControls
        profile={character.voiceProfile}
        disabled={!editable || editing}
        onChange={(patch) => props.onProfileChange(character, patch)}
      />
      <small className="voice-disclosure">AI voice</small>
    </article>
  );
}

function VoiceConversationDialog(props: {
  title: string;
  characters: Array<{ id: string; name: string }>;
  prompt: string;
  error: string | null;
  busy: boolean;
  canSubmit: boolean;
  onPromptChange: (prompt: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="voice-conversation-dialog-backdrop" role="presentation">
      <form
        className="voice-conversation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-conversation-title"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        <div className="voice-conversation-dialog-title">
          <Sparkles size={17} />
          <h4 id="voice-conversation-title">{props.title}</h4>
        </div>
        <div className="voice-conversation-selected">
          {props.characters.map((character) => (
            <span key={character.id}>{character.name}</span>
          ))}
        </div>
        <label>
          Prompt
          <textarea
            rows={4}
            value={props.prompt}
            disabled={props.busy}
            maxLength={2000}
            autoFocus
            onChange={(event) => props.onPromptChange(event.target.value)}
          />
        </label>
        {props.error ? <small className="voice-character-error">{props.error}</small> : null}
        <div className="voice-conversation-dialog-actions">
          <Button size="sm" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant="accent"
            size="sm"
            type="submit"
            disabled={!props.canSubmit || props.busy}
            loading={props.busy}
            loadingLabel="Generating…"
            startIcon={<Sparkles />}
          >
            Generate & play
          </Button>
        </div>
      </form>
    </div>
  );
}

function VoiceConversationList(props: {
  conversations: VoiceConversation[];
  latestConversationId: string | null;
  continuationDisabled: boolean;
  onContinue: (conversation: VoiceConversation) => void;
}) {
  if (props.conversations.length === 0) {
    return null;
  }
  return (
    <div className="voice-conversation-list">
      {props.conversations.map((conversation) => (
        <article key={conversation.id} className="voice-conversation-card">
          <div className="voice-conversation-card-header">
            <div>
              <strong>{conversation.transcript.title ?? "Voice conversation"}</strong>
              <small>
                {conversation.characters.map((character) => character.name).join(" & ")}
                {conversation.durationMs ? ` · ${formatDuration(conversation.durationMs)}` : ""} · {formatRelativeTime(conversation.createdAt)}
              </small>
            </div>
            <FileAudio size={18} />
          </div>
          <p>{conversation.prompt}</p>
          <audio
            controls
            preload="metadata"
            autoPlay={conversation.id === props.latestConversationId}
            src={apiUrl(conversation.audioPath)}
          />
          <details>
            <summary>Transcript</summary>
            <div className="voice-conversation-transcript">
              {conversation.transcript.turns.map((turn, index) => (
                <p key={`${conversation.id}-${index}`}>
                  <strong>{turn.speakerName}</strong>
                  <span>{turn.text}</span>
                </p>
              ))}
            </div>
          </details>
          <Button
            size="sm"
            disabled={props.continuationDisabled}
            onClick={() => props.onContinue(conversation)}
            startIcon={<Sparkles />}
          >
            Continue
          </Button>
        </article>
      ))}
    </div>
  );
}

function hasActivePersonaBuildJob(status: ProjectStatus | null, characterId: string): boolean {
  return (
    status?.project.jobs.some(
      (job) =>
        job.type === "BUILD_CHARACTER_PERSONA" &&
        (job.status === "QUEUED" || job.status === "ACTIVE") &&
        job.payload?.voiceCharacterId === characterId
    ) ?? false
  );
}

function VoiceProfileControls(props: {
  profile: VoiceProfile;
  disabled: boolean;
  onChange: (patch: Partial<VoiceProfile>) => void;
}) {
  return (
    <div className="voice-profile-grid">
      <label>
        Age
        <select
          value={props.profile.ageBand}
          disabled={props.disabled}
          onChange={(event) => props.onChange({ ageBand: event.target.value as VoiceAgeBand })}
        >
          {VOICE_AGE_BAND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Gender
        <select
          value={props.profile.genderPresentation}
          disabled={props.disabled}
          onChange={(event) => props.onChange({ genderPresentation: event.target.value as VoiceGenderPresentation })}
        >
          {VOICE_GENDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Energy
        <select
          value={props.profile.energy}
          disabled={props.disabled}
          onChange={(event) => props.onChange({ energy: event.target.value as VoiceProfile["energy"] })}
        >
          {VOICE_INTENSITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {labelCase(option)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Warmth
        <select
          value={props.profile.warmth}
          disabled={props.disabled}
          onChange={(event) => props.onChange({ warmth: event.target.value as VoiceProfile["warmth"] })}
        >
          {VOICE_INTENSITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {labelCase(option)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Pace
        <select
          value={props.profile.pace}
          disabled={props.disabled}
          onChange={(event) => props.onChange({ pace: event.target.value as VoiceProfile["pace"] })}
        >
          {VOICE_PACE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {labelCase(option)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Formality
        <select
          value={props.profile.formality}
          disabled={props.disabled}
          onChange={(event) => props.onChange({ formality: event.target.value as VoiceProfile["formality"] })}
        >
          {VOICE_FORMALITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {labelCase(option)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function VoiceCallBar(props: {
  call: NonNullable<ActiveVoiceCall>;
  onEnd: () => void;
  onToggleMute: () => void;
}) {
  const statusText = props.call.error ?? voiceCallStatusText(props.call.status);
  return (
    <section className={`voice-call-bar status-${props.call.status}`}>
      <div className="voice-call-identity">
        <div className="voice-avatar small">
          {props.call.character.profileImage ? (
            <img src={apiUrl(props.call.character.profileImage.path)} alt={props.call.character.name} />
          ) : (
            <span>{initialsForName(props.call.character.name)}</span>
          )}
        </div>
        <div>
          <strong>{props.call.character.name}</strong>
          <small>
            {statusText} via {props.call.provider.label} / {props.call.voiceModel}
          </small>
        </div>
      </div>
      <div className="voice-call-actions">
        <IconButton
          label={props.call.muted ? "Unmute microphone" : "Mute microphone"}
          size="sm"
          onClick={props.onToggleMute}
          disabled={!props.call.client}
        >
          {props.call.muted ? <MicOff /> : <Mic />}
        </IconButton>
        <Button variant="danger" size="sm" onClick={props.onEnd} startIcon={<PhoneOff />}>
          End
        </Button>
      </div>
    </section>
  );
}

export function VoiceRoomBar(props: {
  room: NonNullable<ActiveVoiceRoom>;
  onEnd: () => void;
  onToggleMute: () => void;
}) {
  const statusText = props.room.error ?? voiceCallStatusText(props.room.status);
  const currentSpeaker = props.room.characters.find((character) => character.id === props.room.currentSpeakerCharacterId);
  return (
    <section className={`voice-call-bar voice-room-bar status-${props.room.status}`}>
      <div className="voice-call-identity voice-room-identity">
        <div className="voice-room-avatar-stack">
          {props.room.characters.slice(0, 4).map((character) => (
            <div key={character.id} className={`voice-avatar small${character.id === currentSpeaker?.id ? " speaking" : ""}`}>
              {character.profileImage ? (
                <img src={apiUrl(character.profileImage.path)} alt={character.name} />
              ) : (
                <span>{initialsForName(character.name)}</span>
              )}
            </div>
          ))}
        </div>
        <div>
          <strong>{currentSpeaker ? `${currentSpeaker.name} speaking` : "Group voice room"}</strong>
          <small>
            {statusText} via {props.room.provider.label} / {props.room.voiceModel}
          </small>
        </div>
      </div>
      <div className="voice-call-actions">
        <IconButton
          label={props.room.muted ? "Unmute microphone" : "Mute microphone"}
          size="sm"
          onClick={props.onToggleMute}
          disabled={!props.room.client}
        >
          {props.room.muted ? <MicOff /> : <Mic />}
        </IconButton>
        <Button variant="danger" size="sm" onClick={props.onEnd} startIcon={<PhoneOff />}>
          End
        </Button>
      </div>
    </section>
  );
}

function VoiceProviderSelector(props: {
  providers: VoiceProviderInfo[];
  selectedProviderId: VoiceChatProviderId;
  disabled: boolean;
  onChange: (providerId: VoiceChatProviderId) => void;
}) {
  return (
    <div className="voice-provider-selector" role="radiogroup" aria-label="Voice provider">
      {props.providers.map((provider) => {
        const selected = provider.id === props.selectedProviderId;
        const disabled = props.disabled || !provider.configured;
        return (
          <button
            key={provider.id}
            type="button"
            className={`voice-provider-option${selected ? " selected" : ""}`}
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            title={provider.configured ? provider.model : `${provider.label} is not configured`}
            onClick={() => props.onChange(provider.id)}
          >
            <span>{provider.label}</span>
            <small>{provider.configured ? provider.model : "Not configured"}</small>
          </button>
        );
      })}
    </div>
  );
}

function VoiceModelSelector(props: {
  models: VoiceModelOption[];
  selectedModel: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  return (
    <div className="voice-model-selector" role="radiogroup" aria-label="Voice model">
      {props.models.map((model) => {
        const selected = model.model === props.selectedModel;
        return (
          <button
            key={model.model}
            type="button"
            className={`voice-model-option${selected ? " selected" : ""}`}
            role="radio"
            aria-checked={selected}
            disabled={props.disabled}
            title={model.description ?? model.model}
            onClick={() => props.onChange(model.model)}
          >
            <span>{model.label}</span>
            <small>{model.model}</small>
          </button>
        );
      })}
    </div>
  );
}

function voiceCallStatusText(status: ActiveVoiceCallStatus): string {
  if (status === "connected") {
    return "Connected";
  }
  if (status === "reconnecting") {
    return "Reconnecting";
  }
  if (status === "failed") {
    return "Call failed";
  }
  return "Connecting";
}

import {
  Loader2,
  MessageSquareText,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  XCircle
} from "lucide-react";
import {
  apiUrl,
  type VoiceAgeBand,
  type VoiceCharacter,
  type VoiceChatProviderId,
  type VoiceGenderPresentation,
  type VoiceModelOption,
  type VoiceProfile,
  type VoiceProviderInfo
} from "../../api.js";
import { voiceCharacterActionKey } from "../projects/actionKeys.js";
import { initialsForName, labelCase } from "../shared/formatters.js";
import {
  VOICE_AGE_BAND_OPTIONS,
  VOICE_FORMALITY_OPTIONS,
  VOICE_GENDER_OPTIONS,
  VOICE_INTENSITY_OPTIONS,
  VOICE_PACE_OPTIONS
} from "./constants.js";
import type { ActiveVoiceCall, ActiveVoiceCallStatus } from "./types.js";

export function VoiceCharactersPanel(props: {
  characters: VoiceCharacter[];
  busyActions: Record<string, boolean>;
  activeCallCharacterId: string | null;
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
}) {
  const readyCount = props.characters.filter((character) => character.status === "READY").length;
  const selectedProvider = props.providers.find((provider) => provider.id === props.selectedProviderId) ?? props.providers[0] ?? null;
  const selectedModel = props.selectedModel ?? selectedProvider?.model ?? null;
  const statusLabel =
    props.characters.length === 0
      ? ""
      : readyCount > 0
        ? `${readyCount}/${props.characters.length} ready`
        : `${props.characters.length} candidate${props.characters.length === 1 ? "" : "s"}`;

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
        <div className="voice-character-list">
          {props.characters.map((character) => (
            <VoiceCharacterCard
              key={character.id}
              character={character}
              busyActions={props.busyActions}
              active={props.activeCallCharacterId === character.id}
              callDisabled={!selectedProvider?.configured || !selectedModel}
              onApprove={props.onApprove}
              onReject={props.onReject}
              onProfileChange={props.onProfileChange}
              onCall={props.onCall}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VoiceCharacterCard(props: {
  character: VoiceCharacter;
  busyActions: Record<string, boolean>;
  active: boolean;
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
  const building = character.status === "APPROVED" || character.status === "BUILDING";
  const editable = character.status !== "BUILDING" && character.status !== "REJECTED";
  const needsBuild = character.status === "CANDIDATE" || character.status === "FAILED";

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
        {needsBuild ? (
          <button className="icon-text-button accent" onClick={() => props.onApprove(character)} disabled={approving}>
            {approving ? <Loader2 className="spin" size={16} /> : <MessageSquareText size={16} />}
            {character.status === "FAILED" ? "Retry chat build" : "Build chat"}
          </button>
        ) : null}
        {needsBuild ? (
          <button className="icon-text-button danger" onClick={() => props.onReject(character)} disabled={rejecting}>
            {rejecting ? <Loader2 className="spin" size={16} /> : <XCircle size={16} />}
            Reject
          </button>
        ) : null}
        {building ? (
          <span className="voice-building">
            <Loader2 className="spin" size={14} />
            Building chat
          </span>
        ) : null}
        {ready ? (
          <button className="primary-button compact" onClick={() => props.onCall(character)} disabled={props.active || props.callDisabled}>
            <Phone size={16} />
            {props.active ? "In chat" : "Voice chat"}
          </button>
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
        <button className="icon-button" type="button" onClick={props.onToggleMute} disabled={!props.call.client}>
          {props.call.muted ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
        <button className="icon-text-button danger" type="button" onClick={props.onEnd}>
          <PhoneOff size={16} />
          End
        </button>
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

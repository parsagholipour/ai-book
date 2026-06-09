import type { VoiceAgeBand, VoiceGenderPresentation } from "../../api.js";

export const VOICE_AGE_BAND_OPTIONS: Array<{ value: VoiceAgeBand; label: string }> = [
  { value: "child", label: "Child" },
  { value: "teen", label: "Teen" },
  { value: "young_adult", label: "Young adult" },
  { value: "adult", label: "Adult" },
  { value: "elder", label: "Elder" }
];
export const VOICE_GENDER_OPTIONS: Array<{ value: VoiceGenderPresentation; label: string }> = [
  { value: "unknown", label: "Unknown" },
  { value: "neutral", label: "Neutral" },
  { value: "feminine", label: "Feminine" },
  { value: "masculine", label: "Masculine" }
];
export const VOICE_INTENSITY_OPTIONS = ["low", "medium", "high"] as const;
export const VOICE_PACE_OPTIONS = ["slow", "medium", "fast"] as const;
export const VOICE_FORMALITY_OPTIONS = ["casual", "balanced", "formal"] as const;

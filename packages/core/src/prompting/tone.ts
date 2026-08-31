import type { ToneProfile } from "../schemas/book.js";

const toneLabels: Record<ToneProfile, string> = {
  neutral: "Neutral",
  confident: "Confident",
  skeptical: "Skeptical",
  scholarly: "Scholarly",
  conversational: "Conversational",
  narrative: "Narrative"
};

const toneRules: Record<ToneProfile, string[]> = {
  neutral: [
    "Use a balanced, natural tone with moderate confidence.",
    "Let the subject matter set the intensity instead of forcing drama."
  ],
  confident: [
    "Use direct, assertive prose, but do not mistake intensity for proof.",
    "Strong claims should be supported by concrete evidence, textual reasoning, or clearly marked interpretation."
  ],
  skeptical: [
    "Question easy conclusions and avoid turning suggestive evidence into certainty.",
    "Use phrases like possible, suggests, raises the question, or one reading is when the evidence is interpretive."
  ],
  scholarly: [
    "Keep the prose measured, source-aware, and careful about the difference between text, interpretation, and inference.",
    "Prefer precise claims and qualifications over sweeping declarations."
  ],
  conversational: [
    "Write plainly and warmly, as if guiding an intelligent reader without ceremony.",
    "Use shorter connective moves and avoid lecture-like grandeur."
  ],
  narrative: [
    "Let scenes, examples, images, and consequences carry more of the argument.",
    "Favor lived detail over abstract thesis-summary when possible."
  ]
};

export const HUMAN_STYLE_GUARDRAILS = [
  "Avoid proof-leap transitions such as 'This is not a coincidence', 'no accident', 'hidden in plain sight', and 'the truth is' unless directly quoted or genuinely necessary.",
  "Do not stack adjacent contrast sentences that jump from a fact to a sweeping conclusion; earn the claim with evidence, scene, context, or qualification.",
  "Avoid binary-reversal scaffolds such as 'X is not A. It is B.' State B directly unless both halves are needed for a precise correction or distinction, and do not repeat the construction across nearby pages.",
  "Use em dashes and en dashes sparingly; when a dash is ornamental, prefer a period, comma, colon, or a cleaner sentence.",
  "Replace inflated abstractions with concrete examples, precise claims, or human-sized uncertainty.",
  "Preserve the user's thesis and intended edge, but do not make unsupported interpretive claims sound proven."
];

export function toneProfileFromMediaSettings(mediaSettings: { toneProfile?: unknown } | undefined): ToneProfile {
  const value = mediaSettings?.toneProfile;
  return value === "confident" ||
    value === "skeptical" ||
    value === "scholarly" ||
    value === "conversational" ||
    value === "narrative" ||
    value === "neutral"
    ? value
    : "neutral";
}

export function toneLabel(profile: ToneProfile): string {
  return toneLabels[profile];
}

export function toneGuidance(profile: ToneProfile): string[] {
  return [`Tone profile: ${toneLabel(profile)}.`, ...toneRules[profile], ...HUMAN_STYLE_GUARDRAILS];
}

export function writerToneGuidance(profile: ToneProfile): string[] {
  return [
    ...toneGuidance(profile),
    "In reader-facing prose, avoid sounding like a model explaining its own conclusion."
  ];
}

export function plannerToneGuidance(profile: ToneProfile): string[] {
  return [
    ...toneGuidance(profile),
    "Bake this tone into the plan's voiceGuide and antiAiRules so page drafts inherit it."
  ];
}

export function reviewerStyleGuidance(): string[] {
  return [
    "Reject conspicuously AI-styled rhetoric, including formulaic contrast pairs, proof-leap phrases, inflated thesis jumps, and excessive em/en dash use.",
    "A confident or provocative thesis can pass, but only when the page earns its claims through specific evidence, concrete reasoning, or deliberate voice."
  ];
}

import { isSourceForwardBookCategory, type BookCategory } from "../categories.js";
import type { BookPlan, CreateProjectInput, ToneProfile } from "../schemas/book.js";
import { kidsAudienceLabelForInput, kidsReadingGuidanceLines } from "./readingLevel.js";
import { HUMAN_STYLE_GUARDRAILS, toneLabel, toneProfileFromMediaSettings, writerToneGuidance } from "./tone.js";

export type TemplateDefinition = {
  slug: string;
  name: string;
  category: BookCategory;
  description: string;
  defaultConfig: {
    complexity: number;
    temperature: number;
    targetPages: number;
    illustrationCadence: "template-driven" | "every-page" | "manual";
    researchPolicy: "always" | "when-needed" | "rare";
  };
  styleRules: {
    voice: string[];
    structure: string[];
    antiAi: string[];
    qualityChecks: string[];
    imageStyle: string;
  };
};

export const templateDefinitions: TemplateDefinition[] = [
  {
    slug: "kids-picture-book",
    name: "Kids' Books",
    category: "KIDS",
    description: "Warm, visual, page-focused stories for children.",
    defaultConfig: {
      complexity: 3,
      temperature: 0.9,
      targetPages: 32,
      illustrationCadence: "every-page",
      researchPolicy: "when-needed"
    },
    styleRules: {
      voice: [
        "Use concrete, musical language with short sentences.",
        "Let emotion show through action, not explanation.",
        "Keep vocabulary gentle without becoming flat."
      ],
      structure: [
        "Each page should have one clear visual moment.",
        "Repeat a small phrase only if it feels intentional and charming.",
        "End scenes with motion, wonder, or a small turn."
      ],
      antiAi: [
        "Avoid moral-of-the-story summaries.",
        "Avoid generic sparkle, magic, journey, and dream phrasing unless the prompt asks for it.",
        "Use specific sensory details instead of broad adjectives."
      ],
      qualityChecks: [
        "Age-appropriate vocabulary.",
        "No frightening unresolved stakes.",
        "Characters remain visually consistent."
      ],
      imageStyle:
        "cohesive illustrated children's book art, expressive faces, clear silhouettes, soft natural light"
    }
  },
  {
    slug: "science-explainer",
    name: "Science & Nature",
    category: "SCIENCE",
    description: "Accurate, approachable science writing with diagrams and source notes.",
    defaultConfig: {
      complexity: 6,
      temperature: 0.45,
      targetPages: 120,
      illustrationCadence: "template-driven",
      researchPolicy: "always"
    },
    styleRules: {
      voice: [
        "Explain ideas with clean metaphors, then name the precise concept.",
        "Prefer exact claims over dramatic language.",
        "Use examples that make invisible systems feel observable."
      ],
      structure: [
        "Open chapters with a concrete question.",
        "Move from intuition to mechanism to implication.",
        "Use diagrams when relationships, sequences, or scales matter."
      ],
      antiAi: [
        "Do not overuse 'delve', 'unlock', 'realm', 'tapestry', or 'crucial'.",
        "Do not pad explanations with generic wonder.",
        "Flag uncertain or recent claims for research."
      ],
      qualityChecks: [
        "Claims are qualified and source-backed when current.",
        "Key terms are introduced before being used heavily.",
        "Diagrams have text alternatives in Markdown."
      ],
      imageStyle:
        "clean educational diagram style, restrained color, readable labels, accurate scientific composition"
    }
  },
  {
    slug: "story-novel",
    name: "Fiction & Stories",
    category: "STORY",
    description: "Long-form fiction with character continuity and natural prose.",
    defaultConfig: {
      complexity: 5,
      temperature: 0.85,
      targetPages: 220,
      illustrationCadence: "template-driven",
      researchPolicy: "when-needed"
    },
    styleRules: {
      voice: [
        "Write in a textured, human voice with varied sentence rhythm.",
        "Ground scenes in desire, obstacle, and consequence.",
        "Let subtext carry some of the emotion."
      ],
      structure: [
        "Each chapter should alter the character's situation.",
        "Track promises, reveals, objects, injuries, and relationships.",
        "Use quiet scenes for pressure, not filler."
      ],
      antiAi: [
        "Avoid neat paragraph-level conclusions.",
        "Avoid repetitive emotional labels.",
        "Avoid symmetrical scene endings that feel generated."
      ],
      qualityChecks: [
        "No contradiction with the character bible.",
        "No repeated scene shape across adjacent pages.",
        "Dialogue sounds character-specific."
      ],
      imageStyle:
        "cinematic book illustration, consistent character design, realistic lighting, scene-specific composition"
    }
  },
  {
    slug: "education-how-to",
    name: "Education & How-to",
    category: "EDUCATION",
    description: "Clear instruction, practice, and reference-style learning books.",
    defaultConfig: {
      complexity: 5,
      temperature: 0.55,
      targetPages: 100,
      illustrationCadence: "template-driven",
      researchPolicy: "when-needed"
    },
    styleRules: {
      voice: [
        "Teach one concept at a time with plain language and concrete examples.",
        "Prefer practical clarity over motivational filler.",
        "Use checklists, short exercises, and examples when they help the reader act."
      ],
      structure: [
        "Move from concept to demonstration to practice.",
        "Name prerequisites before using specialized ideas.",
        "End chapters with a usable takeaway or next step."
      ],
      antiAi: [
        "Avoid generic mastery, unlock, and transform language.",
        "Do not overpromise outcomes.",
        "Do not bury instructions inside long motivational paragraphs."
      ],
      qualityChecks: [
        "Steps are sequenced and actionable.",
        "Examples match the reader's likely context.",
        "Definitions appear before dependent concepts."
      ],
      imageStyle:
        "clean instructional illustration, readable diagrams, practical examples, uncluttered educational layout"
    }
  },
  {
    slug: "business-career",
    name: "Business & Career",
    category: "BUSINESS",
    description: "Practical business, leadership, finance, and career books.",
    defaultConfig: {
      complexity: 6,
      temperature: 0.55,
      targetPages: 140,
      illustrationCadence: "template-driven",
      researchPolicy: "when-needed"
    },
    styleRules: {
      voice: [
        "Write with pragmatic confidence and specific tradeoffs.",
        "Use crisp examples instead of abstract business slogans.",
        "Separate durable principles from time-sensitive claims."
      ],
      structure: [
        "Open chapters with a decision, problem, or operating reality.",
        "Move from diagnosis to options to execution.",
        "Use frameworks only when they simplify a real choice."
      ],
      antiAi: [
        "Avoid synergy, game-changer, unlock, and market landscape filler.",
        "Do not invent financial claims, customer numbers, or company facts.",
        "Do not make every lesson sound universally applicable."
      ],
      qualityChecks: [
        "Advice is tied to a clear business context.",
        "Risks and constraints are named.",
        "Claims that sound current or quantitative are research-backed."
      ],
      imageStyle:
        "polished editorial business illustration, clean charts, realistic workplace details, restrained color"
    }
  },
  {
    slug: "self-help-guide",
    name: "Self-help & Relationships",
    category: "SELF_HELP",
    description: "Supportive personal growth, habits, relationships, and life guidance.",
    defaultConfig: {
      complexity: 4,
      temperature: 0.7,
      targetPages: 90,
      illustrationCadence: "template-driven",
      researchPolicy: "rare"
    },
    styleRules: {
      voice: [
        "Use warm, direct language without sounding clinical or preachy.",
        "Give the reader room for complexity and imperfect progress.",
        "Prefer grounded exercises over sweeping transformation claims."
      ],
      structure: [
        "Move from recognition to reflection to a small practice.",
        "Use examples that feel lived-in and specific.",
        "End chapters with a manageable action or question."
      ],
      antiAi: [
        "Avoid generic inner-journey phrasing.",
        "Do not shame the reader for struggling.",
        "Do not present personal advice as medical or therapeutic treatment."
      ],
      qualityChecks: [
        "Advice is compassionate and bounded.",
        "Exercises are specific enough to try.",
        "Mental health claims avoid diagnosis or certainty."
      ],
      imageStyle:
        "calm editorial lifestyle illustration, human moments, soft natural light, mature and grounded"
    }
  },
  {
    slug: "health-wellness",
    name: "Health & Wellness",
    category: "HEALTH",
    description: "Evidence-aware wellness, public health, fitness, and patient education books.",
    defaultConfig: {
      complexity: 6,
      temperature: 0.45,
      targetPages: 120,
      illustrationCadence: "template-driven",
      researchPolicy: "always"
    },
    styleRules: {
      voice: [
        "Write carefully, with measured confidence and clear uncertainty.",
        "Separate general education from individual medical advice.",
        "Use concrete explanations for risks, benefits, and mechanisms."
      ],
      structure: [
        "Define the health topic before discussing recommendations.",
        "Move from evidence to practical implications.",
        "Include safety boundaries and when to seek professional care."
      ],
      antiAi: [
        "Do not promise cures, guaranteed outcomes, or miracle routines.",
        "Do not imply personalized diagnosis.",
        "Do not make unsupported supplement, medication, or treatment claims."
      ],
      qualityChecks: [
        "Health claims are source-backed and qualified.",
        "Advice stays educational unless the user supplied clinician-reviewed guidance.",
        "Contraindications and uncertainty are not hidden."
      ],
      imageStyle:
        "clean health education diagram style, readable anatomy or wellness visuals, calm clinical clarity"
    }
  },
  {
    slug: "biography-memoir",
    name: "Biography & Memoir",
    category: "BIOGRAPHY",
    description: "Life stories, memoirs, profiles, and narrative nonfiction.",
    defaultConfig: {
      complexity: 5,
      temperature: 0.7,
      targetPages: 180,
      illustrationCadence: "template-driven",
      researchPolicy: "always"
    },
    styleRules: {
      voice: [
        "Write with narrative intimacy and respect for factual boundaries.",
        "Let scenes, choices, and consequences reveal character.",
        "Balance emotional texture with chronological clarity."
      ],
      structure: [
        "Anchor chapters around turning points, relationships, or formative settings.",
        "Make time jumps explicit.",
        "Separate documented fact from interpretation."
      ],
      antiAi: [
        "Do not invent private thoughts for real people unless framed as interpretation.",
        "Avoid heroic flattening or tidy destiny language.",
        "Do not compress chronology in a misleading way."
      ],
      qualityChecks: [
        "Names, dates, and events are internally consistent.",
        "Speculation is clearly signaled.",
        "The subject's agency and context both remain visible."
      ],
      imageStyle:
        "narrative nonfiction illustration, period-aware details, expressive portraiture, documentary warmth"
    }
  },
  {
    slug: "history-context",
    name: "History",
    category: "HISTORY",
    description: "Historical narrative, political history, local history, and context books.",
    defaultConfig: {
      complexity: 6,
      temperature: 0.55,
      targetPages: 180,
      illustrationCadence: "template-driven",
      researchPolicy: "always"
    },
    styleRules: {
      voice: [
        "Write vivid historical prose without overstating certainty.",
        "Explain causes, constraints, and consequences in human terms.",
        "Use dates and places as anchors, not decoration."
      ],
      structure: [
        "Establish chronology before analysis.",
        "Connect individual events to wider patterns.",
        "Use primary tensions or questions to organize chapters."
      ],
      antiAi: [
        "Do not invent quotations, documents, battles, or statistics.",
        "Avoid present-day moral summaries that flatten the period.",
        "Do not treat contested interpretations as settled fact."
      ],
      qualityChecks: [
        "Chronology is consistent.",
        "Historical claims are source-backed when specific.",
        "Multiple causes or perspectives are represented where relevant."
      ],
      imageStyle:
        "historical editorial illustration, period-specific objects and clothing, map-friendly compositions"
    }
  },
  {
    slug: "society-culture",
    name: "Society & Culture",
    category: "SOCIETY",
    description: "Culture, politics, social issues, philosophy, law, and public life.",
    defaultConfig: {
      complexity: 6,
      temperature: 0.6,
      targetPages: 140,
      illustrationCadence: "template-driven",
      researchPolicy: "when-needed"
    },
    styleRules: {
      voice: [
        "Write with nuance, intellectual honesty, and concrete examples.",
        "Distinguish observation, argument, and recommendation.",
        "Represent opposing viewpoints without caricature."
      ],
      structure: [
        "Frame the central question before taking a position.",
        "Move between lived examples and larger systems.",
        "Name assumptions and stakes when making an argument."
      ],
      antiAi: [
        "Avoid vague society-is-changing generalities.",
        "Do not present contested public claims as simple consensus.",
        "Do not use abstract nouns as a substitute for examples."
      ],
      qualityChecks: [
        "Arguments have evidence or examples.",
        "Sensitive topics are handled with precision.",
        "Legal, political, or current claims are research-backed when needed."
      ],
      imageStyle:
        "thoughtful editorial illustration, diverse public spaces, symbolic but concrete visual metaphors"
    }
  },
  {
    slug: "arts-poetry",
    name: "Arts & Poetry",
    category: "ARTS",
    description: "Poetry, creative craft, art, music, film, food, travel, and expressive books.",
    defaultConfig: {
      complexity: 5,
      temperature: 0.85,
      targetPages: 96,
      illustrationCadence: "template-driven",
      researchPolicy: "rare"
    },
    styleRules: {
      voice: [
        "Honor the requested form and let style carry meaning.",
        "Use precise sensory detail and avoid decorative vagueness.",
        "Let rhythm, image, and structure feel intentionally chosen."
      ],
      structure: [
        "Organize around movements, sequences, themes, or creative lessons.",
        "Give individual pieces enough space to breathe.",
        "Use commentary only when it deepens the work."
      ],
      antiAi: [
        "Avoid generic lyrical abstraction.",
        "Do not explain every image immediately after presenting it.",
        "Do not force inspirational closure onto every piece."
      ],
      qualityChecks: [
        "The form matches the user's stated intent.",
        "Images and metaphors feel specific.",
        "Repeated motifs develop rather than merely recur."
      ],
      imageStyle:
        "expressive editorial art, tactile creative materials, strong composition, style matched to the work"
    }
  },
  {
    slug: "general-book",
    name: "General / Custom",
    category: "CUSTOM",
    description: "Neutral book generation driven by the user's prompt.",
    defaultConfig: {
      complexity: 5,
      temperature: 0.7,
      targetPages: 80,
      illustrationCadence: "template-driven",
      researchPolicy: "rare"
    },
    styleRules: {
      voice: ["Follow the voice, audience, and format implied by the user's prompt."],
      structure: ["Use a coherent book structure that fits the prompt without assuming a genre."],
      antiAi: ["Do not add genre assumptions that the user did not request."],
      qualityChecks: ["The book fulfills the user prompt without app-imposed genre conventions."],
      imageStyle: "visual style requested by the user prompt"
    }
  }
];

export function getTemplateForInput(input: Pick<CreateProjectInput, "category" | "templateSlug">) {
  return (
    templateDefinitions.find((template) => template.slug === input.templateSlug) ??
    templateDefinitions.find((template) => template.category === input.category) ??
    templateDefinitions.find((template) => template.category === "CUSTOM") ??
    templateDefinitions[0]!
  );
}

export type PlanStyleContract = {
  voiceGuide: string[];
  antiAiRules: string[];
};

/**
 * The style contract a plan is composed from: the template's own rules, the kids
 * reading band, and the tone profile split into its two halves. Two sites need
 * it — `makeFallbackPlan` seeds a plan with it, and `ensurePlanStyleContract`
 * (generation/planner.ts) tops a thin model contract back up to it — so it is
 * written once. The second site used to carry its own copy that took no `input`,
 * and every picture book whose planner answered voiceGuide with one line lost
 * the age-appropriate vocabulary and sentence rules from the contract that feeds
 * the drafting, review, and audit passes.
 *
 * `input` is optional because a plan revision can run without one; the tone
 * halves are the part of the contract that is always restorable.
 */
export function planStyleContract(
  input: CreateProjectInput | undefined,
  toneProfile: ToneProfile
): PlanStyleContract {
  const template = input ? getTemplateForInput(input) : undefined;
  const tone = writerToneStyleRules(toneProfile);
  return {
    voiceGuide: [
      ...(template?.styleRules.voice ?? []),
      ...(input ? kidsReadingGuidanceLines(input) : []),
      ...tone.voice
    ],
    antiAiRules: [...(template?.styleRules.antiAi ?? []), ...tone.antiAi]
  };
}

/**
 * `writerToneGuidance` is one prompt list holding three different things: a
 * label line, the profile's own voice rules, and the shared human-style
 * guardrails that follow them. A plan files the middle under voiceGuide, the
 * last under antiAiRules, and the label under neither — "Tone profile: Neutral."
 * names the profile for a prompt heading and is not a rule anyone can write to.
 * Splitting at the first guardrail rather than at `slice(0, 3)` / `slice(3)`
 * keeps the halves right the next time a line is added to either end of it.
 */
function writerToneStyleRules(profile: ToneProfile): { voice: string[]; antiAi: string[] } {
  const lines = writerToneGuidance(profile);
  const firstGuardrail = lines.indexOf(HUMAN_STYLE_GUARDRAILS[0] ?? "");
  const avoidFrom = firstGuardrail >= 0 ? firstGuardrail : lines.length;
  const labelLine = `Tone profile: ${toneLabel(profile)}.`;
  return {
    voice: lines.slice(0, avoidFrom).filter((line) => line !== labelLine),
    antiAi: lines.slice(avoidFrom)
  };
}

export function makeFallbackPlan(input: CreateProjectInput): BookPlan {
  const template = getTemplateForInput(input);
  const chapterCount = Math.max(1, Math.ceil(input.targetPages / 12));
  const basePages = Math.floor(input.targetPages / chapterCount);
  const extra = input.targetPages % chapterCount;
  const title = input.title ?? deriveTitle(input.prompt);
  const styleContract = planStyleContract(input, toneProfileFromMediaSettings(input.mediaSettings));

  return {
    title,
    premise: input.prompt,
    audience: audienceForInput(input),
    writingComplexity: input.complexity,
    voiceGuide: styleContract.voiceGuide,
    antiAiRules: styleContract.antiAiRules,
    questions: [],
    chapters: Array.from({ length: chapterCount }, (_, index) => ({
      index: index + 1,
      title: `Chapter ${index + 1}: ${chapterTitle(index, input.category)}`,
      summary: `Develop the book's central idea through a distinct movement of the outline while preserving continuity with the approved plan.`,
      targetPages: basePages + (index < extra ? 1 : 0),
      keyBeats: [
        "Open with a concrete scene or question.",
        "Advance one clear idea, conflict, or discovery.",
        "End with a reason to continue."
      ]
    })),
    characters: [],
    locations: [],
    continuityRules: [
      "Do not contradict established names, relationships, chronology, or visual details.",
      "When a new recurring detail appears, add it to continuity notes."
    ],
    researchQueries: isSourceForwardBookCategory(input.category) ? [input.prompt] : [],
    researchNotes: [],
    promises: [],
    illustrationPlan: {
      cadence: input.mediaSettings.illustrationCadence,
      globalStyle: input.mediaSettings.imageStyle ?? template.styleRules.imageStyle,
      coverPrompt: `Cover illustration for ${title}: ${input.prompt}`,
      characterReferencePrompts: [],
      pageRules: [
        "Keep recurring characters visually consistent.",
        "Make each illustration readable as a single scene.",
        "Avoid text inside images unless this is a labeled diagram."
      ]
    }
  };
}

function deriveTitle(prompt: string): string {
  return prompt
    .split(/[.!?\n]/)[0]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "Untitled Book";
}

function chapterTitle(index: number, category: string): string {
  if (category === "SCIENCE") {
    return ["The Question", "The Hidden Mechanism", "The Evidence", "The Wider Pattern"][index % 4] ?? "The Pattern";
  }
  if (category === "KIDS") {
    return ["A Small Beginning", "A Curious Turn", "A Brave Try", "A Warm Return"][index % 4] ?? "A Warm Return";
  }
  if (category === "STORY") {
    return ["The Door Opens", "Pressure Builds", "A Choice Narrows", "What Changes"][index % 4] ?? "What Changes";
  }
  if (category === "SELF_HELP") {
    return ["Recognizing the Pattern", "A Smaller Practice", "Working With Resistance", "Carrying It Forward"][
      index % 4
    ] ?? "Carrying It Forward";
  }
  if (category === "BIOGRAPHY") {
    return ["Beginnings", "Turning Point", "Cost and Choice", "Legacy"][
      index % 4
    ] ?? "Legacy";
  }
  if (category === "HISTORY") {
    return ["Before the Turning", "The Event Takes Shape", "Consequences", "What Remained"][
      index % 4
    ] ?? "What Remained";
  }
  if (category === "ARTS") {
    return ["First Motif", "Variation", "Deepening the Form", "Final Movement"][index % 4] ?? "Final Movement";
  }
  if (category === "CUSTOM") {
    return ["Opening", "Development", "Perspective", "Resolution"][index % 4] ?? "Resolution";
  }
  return ["The Core Idea", "The Working Method", "Examples in Practice", "What Comes Next"][
    index % 4
  ] ?? "What Comes Next";
}

function audienceForInput(input: CreateProjectInput): string {
  const kidsAudience = kidsAudienceLabelForInput(input);
  if (kidsAudience) {
    return kidsAudience;
  }
  return audienceForCategory(input.category);
}

function audienceForCategory(category: string): string {
  if (category === "SCIENCE") {
    return "Curious readers who want accurate explanations";
  }
  if (category === "STORY") {
    return "General readers who enjoy character-led stories";
  }
  if (category === "EDUCATION") {
    return "Learners who want clear explanations and useful practice";
  }
  if (category === "BUSINESS") {
    return "Professionals and founders looking for practical judgment";
  }
  if (category === "SELF_HELP") {
    return "Readers seeking practical, humane personal change";
  }
  if (category === "HEALTH") {
    return "Readers who want careful, evidence-aware wellness guidance";
  }
  if (category === "BIOGRAPHY") {
    return "Readers interested in lived experience and meaningful context";
  }
  if (category === "HISTORY") {
    return "Readers who want vivid events grounded in context";
  }
  if (category === "SOCIETY") {
    return "Readers exploring culture, institutions, and public life";
  }
  if (category === "ARTS") {
    return "Readers interested in creative work and expressive craft";
  }
  if (category === "CUSTOM") {
    return "Readers implied by the user's prompt";
  }
  return "General readers";
}

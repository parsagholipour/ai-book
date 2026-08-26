import type { PageProductionBeat } from "../schemas/book.js";

type PageBriefText = Pick<
  PageProductionBeat,
  "purpose" | "beat" | "requiredContinuity" | "endingPressure"
>;

type ReviewedPageBriefRewrite = {
  from: PageBriefText;
  to: PageBriefText;
};

/**
 * Exact rewrites of briefs captured from the diagnosed Wars generation.
 *
 * These are whole-brief matches on purpose: source vocabulary is also valid
 * historical subject matter and fiction material. Unknown briefs pass through
 * byte-for-byte rather than being interpreted by a token or punctuation
 * heuristic.
 */
const REVIEWED_EMPTY_NOTES_REWRITES: readonly ReviewedPageBriefRewrite[] = [
  {
    from: {
      purpose:
        "Open inside the July Crisis through a documented moment in a mobilizing European city, assigning the openingHook without explaining the book or defining the war.",
      beat: "Present a specific sourced observation, notice, diary entry, newspaper report, public announcement, or other record showing ordinary people encountering mobilization, mourning, military preparation, or uncertainty after the Sarajevo assassination. Keep the immediate question concrete: what does this first visible disruption mean, and how quickly can a regional crisis become a war?",
      requiredContinuity: [
        "Identify the date, place, person or record, and source status. Do not invent interior thoughts or dialogue. Clarify that the assassination was a trigger within an already tense international system, not a complete explanation."
      ],
      endingPressure:
        "Leave the reader needing to know how an assassination in Sarajevo could activate decisions across several governments and turn public uncertainty into military movement."
    },
    to: {
      purpose:
        "Open inside the July Crisis in a mobilizing European city, assigning the openingHook without explaining the book or defining the war.",
      beat: "Show ordinary people encountering mobilization, mourning, military preparation, or uncertainty after the Sarajevo assassination. Keep the immediate question concrete: what does this first visible disruption mean, and how quickly can a regional crisis become a war?",
      requiredContinuity: [
        "Keep the date, place, person, or public event concrete. Do not invent interior thoughts or dialogue. Clarify that the assassination was a trigger within an already tense international system, not a complete explanation."
      ],
      endingPressure:
        "Leave the reader needing to know how an assassination in Sarajevo could activate decisions across several governments and turn public uncertainty into military movement."
    }
  },
  {
    from: {
      purpose:
        "Open with a documented civilian or local-government experience that conveys political fragmentation at ground level.",
      beat:
        "Open with a documented civilian or local-government experience that conveys political fragmentation at ground level.",
      requiredContinuity: [
        "Establish that the chapter concerns the Chinese Civil War as a distinct conflict."
      ],
      endingPressure: "Leave a practical political problem."
    },
    to: {
      purpose:
        "Open with civilian or local-government experience that conveys political fragmentation at ground level.",
      beat:
        "Open with civilian or local-government experience that conveys political fragmentation at ground level.",
      requiredContinuity: [
        "Establish that the chapter concerns the Chinese Civil War as a distinct conflict."
      ],
      endingPressure: "Leave a practical political problem."
    }
  },
  {
    from: {
      purpose:
        "Open with civilians confronting the German invasion of Poland in September 1939, using a documented location, testimony, photograph, diary, or official record.",
      beat:
        "Open with civilians confronting the German invasion of Poland in September 1939, using a documented location, testimony, photograph, diary, or official record.",
      requiredContinuity: ["Place the opening within the chronology of the German-Soviet invasion."],
      endingPressure: "End with occupation as a system."
    },
    to: {
      purpose: "Open with civilians confronting the German invasion of Poland in September 1939.",
      beat: "Open with civilians confronting the German invasion of Poland in September 1939.",
      requiredContinuity: ["Place the opening within the chronology of the German-Soviet invasion."],
      endingPressure: "End with occupation as a system."
    }
  },
  {
    from: {
      purpose:
        "Open with a documented moment from the December 1944 crisis that places readers inside the uncertainty of liberation and contested authority.",
      beat:
        "Open with a documented moment from the December 1944 crisis that places readers inside the uncertainty of liberation and contested authority.",
      requiredContinuity: [
        "Define the occupation, resistance movements, government-in-exile, and return of political authority. Identify whose testimony or record supports the opening scene."
      ],
      endingPressure: "Ask how a resistance movement became an opponent of the postwar state."
    },
    to: {
      purpose:
        "Open with a moment from the December 1944 crisis that places readers inside the uncertainty of liberation and contested authority.",
      beat:
        "Open with a moment from the December 1944 crisis that places readers inside the uncertainty of liberation and contested authority.",
      requiredContinuity: [
        "Define the occupation, resistance movements, government-in-exile, and return of political authority."
      ],
      endingPressure: "Ask how a resistance movement became an opponent of the postwar state."
    }
  },
  {
    from: {
      purpose: "Open with a documented human experience of displacement.",
      beat: "Begin with a sourced account from a displaced person, relief worker, journalist, or official record during the flight from violence in 1966 or the early months of the war. Identify the place, date, and nature of the evidence, then briefly locate the reader in southeastern Nigeria.",
      requiredContinuity: ["Do not imply that one testimony represents all displaced people."],
      endingPressure: "End with why political crisis became mass displacement."
    },
    to: {
      purpose: "Open with the public effects of displacement.",
      beat: "Begin with the public effects of the flight from violence in 1966 or the early months of the war. Keep the place and date concrete, then briefly locate the reader in southeastern Nigeria.",
      requiredContinuity: ["Do not imply that one person's experience represents all displaced people."],
      endingPressure: "End with why political crisis became mass displacement."
    }
  },
  {
    from: {
      purpose: "Show how residents understood the order.",
      beat: "Name a civilian diary and quote its account of the order.",
      requiredContinuity: ["Identify the diary or archive holding it."],
      endingPressure: "Land on the limits of the surviving record."
    },
    to: {
      purpose: "Show how residents understood the order.",
      beat: "Show how residents understood the order through grounded public facts.",
      requiredContinuity: [],
      endingPressure: "Land on what remains uncertain about residents' response."
    }
  },
  {
    from: {
      purpose: "Open on a documented civilian account of mobilisation.",
      beat:
        "Quote a civilian diary, named testimony, and archive holding showing how Sarajevo's news reached a mobilizing city.",
      requiredContinuity: ["Identify the diary or archive and its source status."],
      endingPressure: "The reader needs the next cabinet's choice."
    },
    to: {
      purpose: "Open on how civilians experienced mobilisation through grounded public facts.",
      beat: "Show how Sarajevo's news reached a mobilizing city.",
      requiredContinuity: [],
      endingPressure: "The reader needs the next cabinet's choice."
    }
  }
];

export function rewriteReviewedEmptyNotesPageBrief(pageBrief: PageProductionBeat): PageProductionBeat {
  const rewrite = REVIEWED_EMPTY_NOTES_REWRITES.find(({ from }) => hasExactText(pageBrief, from));
  return rewrite ? { ...pageBrief, ...rewrite.to } : pageBrief;
}

function hasExactText(pageBrief: PageProductionBeat, expected: PageBriefText): boolean {
  return (
    pageBrief.purpose === expected.purpose &&
    pageBrief.beat === expected.beat &&
    pageBrief.endingPressure === expected.endingPressure &&
    pageBrief.requiredContinuity.length === expected.requiredContinuity.length &&
    pageBrief.requiredContinuity.every((item, index) => item === expected.requiredContinuity[index])
  );
}

import { describe, expect, it } from "vitest";
import { bookEpisodesSchema, type BookEpisodes } from "../schemas/episodes.js";
import {
  applyFocusContract,
  chapterStyleNotes,
  episodeCollisions,
  focusContractIssues,
  focusFeedbackLines,
  isMethodShaped,
  stanceIsMethodShaped
} from "./planContract.js";

// The calibration set: hand-written stance positions that must pass, and the
// fields of the stored plans (2026-09-05 whole-book, 2026-09-06 fresh-plan)
// three blind readers named as one paragraph engine.
const FLAT_POSITIONS = [
  "Violence in history is organised before it is felt: someone decides who may be harmed, and that decision leaves a record.",
  "The offices that police a state's own subjects are the offices that build harm on a scale no feud reaches.",
  "Every weapon in this book was pointed by an institution, and the institution is the subject."
];

const METHOD_CONTRIBUTIONS = [
  "The reader can distinguish evidence of violent capability and a particular attack from evidence of violence's frequency or universality.",
  "The reader can separate recurrent local danger from a claim that all mobile societies were continuously at war.",
  "The reader can identify honor as a social incentive structure that authorizes and limits retaliation, rather than as a timeless emotional instinct.",
  "The reader can trace devaluation from legal classification to administrative coordination without treating prejudice, persecution, and mass murder as identical stages.",
  "Readers can see slavery as a coordinated legal-economic institution rather than an accumulation of individual cruelties."
];

const METHOD_QUESTIONS = [
  "What can a violent archaeological assemblage establish about aggression, and what does it leave undecided?",
  "What does a legal text reveal about how authority classifies injury and obligation, and what does it conceal?"
];

const PLAIN_QUESTIONS = [
  "How does a city-state convert private retaliation and social conflict into publicly administered coercion?",
  "How did settled production create both objects of conflict and institutions for collective protection?",
  "What do Amsterdam's homicide counts and source series actually measure, and how do they change over time?"
];

const METHOD_STANCE_POSITIONS = [
  "Archaeological evidence shows that organized violence has deep roots, but it does not establish that warfare was constant or universal in every early society.",
  "The historical record contains both violence and cooperation, so neither permanent human brutality nor an originally peaceful humanity explains the whole past."
];

const METHOD_VOICE_LINES = [
  "Separate what evidence shows from what scholars infer, especially when archaeological remains cannot reveal motives or the full scale of past violence.",
  "Use moderate confidence. Name competing interpretations when the available evidence genuinely supports more than one reading."
];

const PLAIN_VOICE_LINES = [
  "Use clear historical prose for general readers, with concrete scenes, artifacts, institutions, and decisions carrying the explanation.",
  "Keep the tone humane and unsensational when describing injury, death, conquest, and trauma."
];

// Rules about *shape* — where a chapter, section or paragraph ends, opens or how
// long it runs — which the writer performs on schedule when it is shown one.
const SHAPE_VOICE_LINES = [
  "Vary chapter endings. Some should close on a bounded conclusion, some on an unresolved question, and some on a document or scene that changes the reader's perspective.",
  "Open each chapter on a document rather than a summary.",
  "Vary paragraph lengths across the chapter."
];

describe("isMethodShaped", () => {
  it("passes hand-written positions that state a fact about the world", () => {
    for (const position of FLAT_POSITIONS) {
      expect(isMethodShaped(position, { keywords: true })).toBe(false);
    }
  });

  it("flags a contribution that is a distinction between two readings", () => {
    for (const contribution of METHOD_CONTRIBUTIONS) {
      expect(isMethodShaped(contribution)).toBe(true);
    }
  });

  it("flags a question about what the evidence can and cannot establish, and passes one about the material", () => {
    for (const question of METHOD_QUESTIONS) expect(isMethodShaped(question)).toBe(true);
    for (const question of PLAIN_QUESTIONS) expect(isMethodShaped(question)).toBe(false);
  });

  it("keeps the evidence keyword off questions and investigation lines", () => {
    const investigation = PLAIN_QUESTIONS[2]!;
    expect(isMethodShaped(investigation)).toBe(false);
    expect(isMethodShaped(investigation, { keywords: true })).toBe(true);
  });

  it("flags a hedged evidence stance under the keyword rule", () => {
    for (const position of METHOD_STANCE_POSITIONS) {
      expect(isMethodShaped(position, { keywords: true })).toBe(true);
    }
    expect(stanceIsMethodShaped({ thesis: FLAT_POSITIONS[0]!, positions: METHOD_STANCE_POSITIONS })).toBe(true);
    expect(stanceIsMethodShaped({ thesis: METHOD_STANCE_POSITIONS[0]!, positions: FLAT_POSITIONS })).toBe(true);
    expect(stanceIsMethodShaped({ thesis: FLAT_POSITIONS[0]!, positions: FLAT_POSITIONS })).toBe(false);
  });
});

describe("chapterStyleNotes", () => {
  // The voice guide is the planner's own answer about how the book sounds.
  // A keyword or shape filter over it used to withhold a valid distinction
  // ("rather than") and a valid source caution from every chapter call.
  it("keeps every voiceGuide line verbatim and in order, distinctions and source caution included", () => {
    const carried =
      "Let places, objects, bodies, settlements, laws, and documents carry the narrative rather than relying on sweeping abstractions.";
    const guide = [...PLAIN_VOICE_LINES, carried, ...METHOD_VOICE_LINES, ...SHAPE_VOICE_LINES];
    expect(chapterStyleNotes(guide)).toEqual(guide);
  });

  it("returns a copy, and an empty guide stays empty", () => {
    const guide = [...METHOD_VOICE_LINES];
    const notes = chapterStyleNotes(guide);
    expect(notes).toEqual(guide);
    expect(notes).not.toBe(guide);
    expect(chapterStyleNotes([])).toEqual([]);
  });
});

function episodesOf(chapters: Array<{ index: number; titles: string[]; focus?: unknown }>): BookEpisodes {
  return bookEpisodesSchema.parse({
    chapters: chapters.map((chapter) => ({
      index: chapter.index,
      episodes: chapter.titles.map((title) => ({ title, kind: "document" })),
      ...(chapter.focus ? { focus: chapter.focus } : {})
    }))
  });
}

describe("focusContractIssues", () => {
  it("names the chapter and the field of every method-shaped focus", () => {
    const episodes = episodesOf([
      {
        index: 1,
        titles: ["A roll"],
        focus: { question: PLAIN_QUESTIONS[0], investigation: ["the sequence of decisions", "the carting costs"], contribution: "The reader will know who paid for the wall and when." }
      },
      {
        index: 4,
        titles: ["A statute"],
        focus: { question: METHOD_QUESTIONS[0], investigation: ["the sequence of decisions", METHOD_CONTRIBUTIONS[1]], contribution: METHOD_CONTRIBUTIONS[0] }
      }
    ]);
    expect(focusContractIssues(episodes)).toEqual([
      { chapterIndex: 4, kind: "question", text: METHOD_QUESTIONS[0] },
      { chapterIndex: 4, kind: "contribution", text: METHOD_CONTRIBUTIONS[0] },
      { chapterIndex: 4, kind: "investigation", text: METHOD_CONTRIBUTIONS[1] }
    ]);
  });
});

describe("episodeCollisions", () => {
  it("flags two chapters that took the same case", () => {
    const episodes = bookEpisodesSchema.parse({
      chapters: [
        {
          index: 1,
          episodes: [
            {
              title: "The Nataruk mass-killing site",
              kind: "scene",
              person: "The excavated remains",
              place: "Nataruk, near Lake Turkana, Kenya",
              document: "Marta Mirazón Lahr et al., \"Inter-group violence among early Holocene hunter-gatherers of West Turkana, Kenya,\" Nature (2016)"
            }
          ]
        },
        {
          index: 14,
          episodes: [
            {
              title: "The Nataruk interpretation revisited",
              kind: "dispute",
              person: "Marta Mirazón Lahr and colleagues, and critics of the massacre interpretation",
              place: "Nataruk, Kenya",
              document: "Lahr et al., \"Inter-group violence among early Holocene hunter-gatherers of West Turkana, Kenya,\" and subsequent scholarly responses"
            }
          ]
        }
      ]
    });
    const collisions = episodeCollisions(episodes);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.earlier.chapterIndex).toBe(1);
    expect(collisions[0]!.later.chapterIndex).toBe(14);
    expect(collisions[0]!.shared).toEqual(expect.arrayContaining(["Nataruk", "Kenya", "Lahr"]));
    // "Nataruk", "Turkana" and "Kenya" are places on both sides; the excavators
    // named in one episode's person field and the other's document are strong.
    expect(collisions[0]!.strong.sort()).toEqual(["Lahr", "Marta", "Mirazón"]);
  });

  it("flags the Haitian Declaration taken twice", () => {
    const episodes = episodesOf([
      { index: 8, titles: ["The Haitian Declaration of Independence"] },
      { index: 10, titles: ["The Haitian Revolution's Declaration of the Rights of Man"] }
    ]);
    expect(episodeCollisions(episodes)[0]!.shared.sort()).toEqual(["Declaration", "Haitian"]);
  });

  it("does not flag two massacres that share one stoplisted word", () => {
    expect(
      episodeCollisions(
        episodesOf([
          { index: 1, titles: ["The Massacre at Sand Creek testimony"] },
          { index: 2, titles: ["The Crow Creek massacre"] }
        ])
      )
    ).toEqual([]);
  });

  it("needs a shared token that identifies the case, not one that houses or places it", () => {
    // Two different artefacts in the British Museum, and two chapters sharing
    // only two nationalities: both were false positives on a stored plan.
    expect(
      episodeCollisions(
        episodesOf([
          { index: 3, titles: ["The Flood Tablet, British Museum"] },
          { index: 4, titles: ["The Rosetta Stone, British Museum"] }
        ])
      )
    ).toEqual([]);
    expect(
      episodeCollisions(
        episodesOf([
          { index: 11, titles: ["British and German casualty tables for the Somme"] },
          { index: 12, titles: ["A British trade treaty with German shipbuilders"] }
        ])
      )
    ).toEqual([]);
  });

  it("flags a duplication whose shared tokens include a strong one, across identity and document", () => {
    const collisions = episodeCollisions(
      bookEpisodesSchema.parse({
        chapters: [
          { index: 8, episodes: [{ title: "The Nuremberg Laws and Nazi Jewish policy", kind: "document", document: "Reichsgesetzblatt I (1935)" }] },
          {
            index: 12,
            episodes: [
              { title: "Nazi Jewish policy at Wannsee", kind: "document", document: "The Wannsee protocol, read at the Nuremberg trials" }
            ]
          }
        ]
      })
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.shared.sort()).toEqual(["Jewish", "Nazi", "Nuremberg"]);
    // "Nazi" and "Jewish" are weak, so this is reported and never dropped.
    expect(collisions[0]!.strong).toEqual(["Nuremberg"]);
    expect(applyFocusContract(bookEpisodesSchema.parse({
      chapters: [
        { index: 8, episodes: [{ title: "The Nuremberg Laws and Nazi Jewish policy", kind: "document", document: "Reichsgesetzblatt I (1935)" }] },
        {
          index: 12,
          episodes: [
            { title: "Nazi Jewish policy at Wannsee", kind: "document", document: "The Wannsee protocol, read at the Nuremberg trials" },
            { title: "The Einsatzgruppen reports", kind: "document", document: "Ereignismeldungen UdSSR" }
          ]
        }
      ]
    })).dropped).toEqual([]);
  });

  it("does not flag two cases in one city, even when the city is in both titles", () => {
    // The relaunched run dropped the second of these: "London" is in both
    // titles and both places, so it is a city rather than a case.
    const episodes = bookEpisodesSchema.parse({
      chapters: [
        {
          index: 8,
          episodes: [
            {
              title: "The London Coroners' Rolls",
              kind: "document",
              person: "The coroners and victims recorded in medieval London",
              place: "London, England",
              document: "Barbara A. Hanawalt, Crime and Conflict in English Communities, 1300-1348 (1979)"
            }
          ]
        },
        {
          index: 11,
          episodes: [
            {
              title: "The Decline of Homicide in London",
              kind: "figure",
              person: "Manuel Eisner",
              place: "London, England",
              document: "Manuel Eisner, \"Modernization, Self-Control and Lethal Violence in Western Europe,\" British Journal of Criminology (2001)."
            }
          ]
        }
      ]
    });
    expect(episodeCollisions(episodes)).toEqual([]);
    expect(applyFocusContract(episodes).dropped).toEqual([]);
  });

  it("never counts an overlap that is document against document alone", () => {
    // The live run's four dropped episodes: one modern historian cited for two
    // different cases, a polity, and a book title's word against a place.
    const thirtyYears = {
      title: "The Thirty Years' War and the Military Entrepreneur",
      kind: "portrait",
      person: "Albrecht von Wallenstein",
      place: "Bohemia and the Holy Roman Empire",
      document: "Geoffrey Parker, The Thirty Years' War (1984)"
    };
    const calicut = {
      title: "The Portuguese Cannon at Calicut",
      kind: "scene",
      person: "Vasco da Gama and the Zamorin of Calicut",
      place: "Calicut, India",
      document: "Álvaro Velho, The Roteiro of a Journey to India, translated by H. E. J. Stanley (1869)"
    };
    const ordinances = {
      title: "The Swedish Army's Contribution Ordinances",
      kind: "document",
      person: "Gustavus Adolphus and Swedish military administrators",
      place: "Swedish-occupied German territories",
      document: "Geoffrey Parker, The Military Revolution: Military Innovation and the Rise of the West, 1500–1800 (1988), discussion of wartime contributions"
    };
    const carolina = {
      title: "The Carolina Criminal Code",
      kind: "document",
      person: "Charles V, Holy Roman Emperor",
      place: "Holy Roman Empire",
      document: "The Constitutio Criminalis Carolina, translated in John H. Wigmore, A Panorama of the World's Legal Systems (1928)"
    };
    const rebellion = {
      title: "The Indian Rebellion Census and Classification",
      kind: "document",
      person: "William H. Sleeman and British colonial administrators",
      place: "North India",
      document: "William H. Sleeman, A Journey through the Kingdom of Oude (1858), alongside British parliamentary papers on the Indian Rebellion"
    };
    expect(
      episodeCollisions(
        bookEpisodesSchema.parse({
          chapters: [
            { index: 6, episodes: [thirtyYears, calicut] },
            { index: 7, episodes: [ordinances] },
            { index: 8, episodes: [carolina] },
            { index: 9, episodes: [rebellion] }
          ]
        })
      )
    ).toEqual([]);
  });

  it("does not flag two cases that share only a country", () => {
    // From the live run's saved answers: a shared "British India" and a shared
    // South Africa are places, and a place names no case.
    const indianRebellion = {
      title: "The Indian Rebellion Census and Classification",
      kind: "document",
      person: "William H. Sleeman and British colonial administrators",
      place: "North India",
      document: "William H. Sleeman, A Journey through the Kingdom of Oude (1858), alongside British parliamentary papers on the Indian Rebellion"
    };
    const bengalFamine = {
      title: "The Bengal Famine Commission Report",
      kind: "figure",
      person: "The Bengal Famine Commission",
      place: "Bengal, British India",
      document: "Famine Inquiry Commission, Report on Bengal (1945)"
    };
    const passLaws = {
      title: "The Apartheid Pass Laws",
      kind: "document",
      person: "South African Parliament and pass-law officials",
      place: "South Africa",
      document: "The Natives (Abolition of Passes and Coordination of Documents) Act, 1952, South African legislative text."
    };
    const truthCommission = {
      title: "The Truth and Reconciliation Commission Final Report",
      kind: "document",
      person: "Desmond Tutu and the South African Truth and Reconciliation Commission",
      place: "South Africa",
      document: "Truth and Reconciliation Commission of South Africa, Final Report, five volumes."
    };
    expect(
      episodeCollisions(
        bookEpisodesSchema.parse({
          chapters: [
            { index: 9, episodes: [indianRebellion] },
            { index: 11, episodes: [bengalFamine, passLaws] },
            { index: 12, episodes: [truthCommission] }
          ]
        })
      )
    ).toEqual([]);
  });

  it("does not flag two episodes sharing only a host or a generic title word", () => {
    expect(
      episodeCollisions(
        episodesOf([
          { index: 1, titles: ["A King's Book on Wikisource, General Report"] },
          { index: 2, titles: ["The United Council Book, General Case at Project Gutenberg"] }
        ])
      )
    ).toEqual([]);
  });
});

describe("focusFeedbackLines", () => {
  it("names the chapter numbers of every issue and collision", () => {
    const episodes = episodesOf([
      { index: 1, titles: ["The Nataruk mass-killing site at Lake Turkana"] },
      { index: 2, titles: ["A statute"], focus: { question: PLAIN_QUESTIONS[0], investigation: ["a", "b"], contribution: METHOD_CONTRIBUTIONS[0] } },
      { index: 3, titles: ["The Nataruk site at Lake Turkana revisited"] }
    ]);
    const lines = focusFeedbackLines(focusContractIssues(episodes), episodeCollisions(episodes));
    expect(lines[0]).toContain("Chapter 2: contribution");
    expect(lines[0]).toContain("is a distinction between two readings");
    expect(lines.some((line) => line.startsWith("Chapters 1 and 3 both take"))).toBe(true);
  });
});

describe("applyFocusContract (compatibility wrapper)", () => {
  // The wrapper exists for the archived replay script. It used to blank a
  // contribution, filter investigation lines and drop a later chapter's
  // episode on the same heuristics; it now hands the episodes back untouched.
  it("returns the episodes as they were, with nothing dropped or blanked", () => {
    const episodes = episodesOf([
      {
        index: 1,
        titles: ["The Nataruk mass-killing site at Lake Turkana"],
        focus: { question: METHOD_QUESTIONS[0], investigation: ["the sequence of decisions", "the carting costs", METHOD_CONTRIBUTIONS[0]], contribution: METHOD_CONTRIBUTIONS[0] }
      },
      { index: 3, titles: ["The Nataruk site at Lake Turkana revisited", "A Roman tax register"] }
    ]);
    const result = applyFocusContract(episodes);
    expect(result.episodes).toBe(episodes);
    expect(result.dropped).toEqual([]);
    expect(result.blanked).toEqual([]);
    expect(result.episodes.chapters[0]!.focus!.contribution).toBe(METHOD_CONTRIBUTIONS[0]);
    expect(result.episodes.chapters[0]!.focus!.investigation).toHaveLength(3);
    expect(result.episodes.chapters[1]!.episodes.map((episode) => episode.title)).toEqual(["The Nataruk site at Lake Turkana revisited", "A Roman tax register"]);
  });
});

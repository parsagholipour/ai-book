/**
 * What a raised refusal *means*, once a provider has raised one.
 *
 * The other half of `imageRefusal.ts`: that module decides whether prose in a
 * picture's place is a filter answering at all, and this one reads the refusal
 * it produced — whether both attempts of a fallback settled it, and whether a
 * rewritten prompt may honestly answer it. They are split because they are two
 * decisions with two different readers — an adapter raises a refusal, and
 * `CopyrightSafeRetryImageAdapter` in the worker is the only thing that asks
 * what one means — and because together they had grown past the 900-line
 * budget `pnpm check:sizes` enforces.
 *
 * Every reading here obeys one rule, and it is the rule this pair has now been
 * caught breaking four times: **a `reason` is machine vocabulary and a bare
 * word test over it is safe; prose is mostly Gemini's native models restating
 * the request, so a bare word test over *that* reads the picture the book asked
 * for.** The veto read `/child|minor/` over the restatement and vetoed every
 * children's book; the Imagen score table was folded into `reason` and vetoed
 * every Imagen block; the compound label `child safety` read a crossing-safety
 * lesson; and the copyright evidence read `copyright-free` in a prompt about a
 * vintage poster. Each fix is the same shape — the word only counts where the
 * filter's own statement puts it — and each is written down beside the pattern
 * it governs.
 */
import {
  CLEARED_CONTENT_EVIDENCE,
  isImageContentRefusalError,
  refusalEvidence,
  type RefusalEvidence
} from "./imageRefusal.js";

/**
 * Whether a refusal is one a rewritten prompt could honestly answer.
 *
 * `"copyright"` means the filter objected to a *name* — a protected character,
 * franchise or brand — which a prompt describing an original character in the
 * same role does not have. That is a real creative answer rather than an
 * evasion, and it is the only category anything is allowed to retry.
 *
 * Two rules keep it honest. Positive evidence is required: a recitation finish
 * reason, or the words a filter uses when it means intellectual property. And
 * the veto below refuses outright, whatever else the refusal says — those are
 * the categories where an automatic second attempt is not something to build,
 * and no evidence on the other side outweighs them.
 *
 * Note the asymmetry with a bare `SAFETY` or `PROHIBITED_CONTENT`: those are
 * the labels Gemini also puts on a character likeness, so they neither prove
 * copyright nor veto. They simply carry no evidence, and a refusal with no
 * evidence is not retried.
 */
export type ImageRefusalCategory = "copyright" | "other";

export function imageRefusalCategory(error: unknown): ImageRefusalCategory {
  if (!isImageContentRefusalError(error)) {
    return "other";
  }
  const evidence = refusalEvidence(error);
  if (isNeverRewritableRefusal(evidence)) {
    return "other";
  }
  return namesIntellectualProperty(evidence);
}

const COPYRIGHT_EVIDENCE = /recitation|copyright|trademark|infring|intellectual property/i;

/**
 * The positive half, and the same split every other rule here is written on:
 * a `reason` is machine vocabulary, prose is mostly the request read back.
 *
 * Over a code, the bare word test stands — the filter wrote `IMAGE_RECITATION`
 * or `RAI_FILTERED: copyright` about *this* request and nothing else. Over
 * prose it was the permissive half of the mistake the veto below is written
 * against: a book asking for `"in the style of a copyright-free vintage travel
 * poster"` is blocked for `IMAGE_SAFETY`, the native model restates the request
 * in the picture's place, `/copyright/i` matches the *scene*, and
 * `CopyrightSafeRetryImageAdapter` buys a paid text rewrite per refused
 * illustration for a block that was never about IP. Scanned twice, at that:
 * `ImageContentRefusedError`'s message embeds `detail`, so both copies are in
 * `prose`.
 *
 * What tells the two apart already exists — {@link CLEARED_CONTENT_EVIDENCE},
 * the veto reading 2 has carried since a drawn picture's compliance narration
 * ("the design is original and does not infringe", "copyright is not a
 * concern") was refusing books. This test simply never had it. It is applied
 * **per sentence** rather than over the whole string, which is what
 * `[^.!?]{0,40}` inside those patterns already means by "near": prose reading
 * `"The image would infringe copyright. Copyright-free art is fine."` keeps the
 * objection its first sentence makes instead of being cleared by its second.
 *
 * Reading it per sentence is only half of what that costs, and the other half
 * is this test's to know about: with one sentence to work from, a refusal that
 * states what it *will not do* uses the same words a clearance uses about what
 * a picture *lacks*, and the objecting sentence was discounted by its own verb
 * — `"I must avoid generating content that infringes on intellectual
 * property"` was `other`. That is why {@link CLEARED_CONTENT_EVIDENCE} reads
 * tense and stance rather than vocabulary; the reasoning lives beside the list,
 * because the other reader of it is written under the opposite asymmetry.
 *
 * A *frame* requirement — the way the veto below asks `child safety` to sit
 * beside a filter asserting something — is deliberately not the answer here,
 * and the direction is why. Over-matching costs one rewrite call that comes
 * back refused; under-matching costs the picture, because a rewrite genuinely
 * warranted is never offered and nothing else will ask again. Gemini's native
 * refusals say `"I can't create an image of Spider-Man, a copyrighted
 * character."` with no assertion word in them at all — the decline *is* the
 * frame — so requiring one would drop the exact refusals this retry exists
 * for. On the veto side that trade is affordable because the code half is a
 * second door onto the same verdict; here there is no second door.
 */
function namesIntellectualProperty(evidence: RefusalEvidence): ImageRefusalCategory {
  const named =
    evidence.codes.some((code) => COPYRIGHT_EVIDENCE.test(code)) ||
    evidence.prose.some((text) =>
      sentencesOf(text).some(
        (sentence) =>
          COPYRIGHT_EVIDENCE.test(sentence) && !CLEARED_CONTENT_EVIDENCE.some((pattern) => pattern.test(sentence))
      )
    );
  return named ? "copyright" : "other";
}

/**
 * A sentence, in the same terms every bounded gap in this module already uses
 * for one: `[^.!?]` is where those stop, so this stops there too. A newline
 * ends one as well, because a provider that lists its objections gives each its
 * own line and no punctuation.
 */
function sentencesOf(text: string): string[] {
  return text.split(/[.!?\r\n]+/);
}

/**
 * The veto, decided by what the *filter* named and never by the scene.
 *
 * The two halves of a refusal are not the same kind of statement, and this is
 * the one place that difference is load bearing. A `reason` is the provider's
 * own code — `IMAGE_SAFETY`, `DataInspectionFailed`, `SEXUALLY_EXPLICIT` —
 * machine vocabulary that describes the filter and nothing else, so a bare word
 * test over it is safe. The prose beside it is not: for Gemini's native image
 * models it is largely the text part the model returned *instead* of the
 * picture, and that part restates the request back — "I can't create an image
 * of Spider-Man teaching a child to read".
 *
 * Testing `/child|minor/` against that sentence read the scene rather than the
 * filter, and the product's books are largely children's books, so the textbook
 * case this whole retry was built for vetoed itself. Silently, too: the gate
 * used to short-circuit past every run-log line the retry writes, so a refused
 * picture showed no trace of a rewrite ever being considered — which is why an
 * inert veto has always had to be found rather than seen, and why the gate now
 * appends `copyright_rewrite_not_offered` before it rethrows.
 *
 * Pairing the protected person with a harm word inside one sentence was the
 * first answer to that, and it was a false floor: *both* halves of the pair are
 * ordinary intellectual-property English. A filter objecting to a cartoon
 * character says the picture would "exploit a copyrighted character", that a
 * likeness "in a children's book would exploit Disney's trademark", that the
 * request is "commercial exploitation of a trademarked children's franchise",
 * or that "a minor variation on a copyrighted design would still exploit the
 * original" — "abuse of the trademark" and "endangered species" read the same
 * way, and `minor` is an English adjective before it is a person. Every one of
 * those is the refusal this retry exists for, and every one of them vetoed
 * itself: the same silent short-circuit, one bug further in.
 *
 * So over prose the harm word has to *govern* the person rather than merely
 * share a clause with it — as its object ("exploitation of children", "exploits
 * a child", "abuse of minors"), or with the person as its subject ("children
 * who are being exploited", "a minor being abused"). What may stand in the gap
 * between them is a closed list of prepositions, determiners and modifiers,
 * which is the whole difference between a filter naming a victim and a filter
 * naming a rights-holder: "exploitation of **the trademarked** children's
 * franchise" and "child **to read, as this would** exploit" both fall out on
 * the words in the gap alone. The harm words that stand alone stand alone
 * because none of them describes an illustration a book asked for — a scene is
 * never restated as nudity, or as sexual — and the filter's own compound label
 * ("child safety", `child_sexual_abuse_material`) needs no grammar at all.
 *
 * Being wrong in the permissive direction costs one rewritten prompt that comes
 * back refused in exactly the same way — a rewrite may only remove protected
 * *names* — and that second refusal is the end of it. Being wrong in the other
 * direction is a picture nobody may ask for again, so where the two readings
 * genuinely collide the veto keeps the person: "a minor being abused" is a
 * child, "a minor character from the film" is a small part, and what tells them
 * apart is whether a noun is standing behind the adjective at all.
 */
function isNeverRewritableRefusal(evidence: RefusalEvidence): boolean {
  return (
    evidence.codes.some((code) => NEVER_REWRITABLE_CODE.test(code)) ||
    evidence.prose.some((text) => NEVER_REWRITABLE_VOCABULARY.some((pattern) => pattern.test(text)))
  );
}

/** Over a provider's own code, where every word is the filter describing itself. */
const NEVER_REWRITABLE_CODE = /child|minor|csam|sexual|nudity|nude|nsfw|porn|explicit/i;

/**
 * What may follow the person `minor` and nothing else can: the end of the text,
 * punctuation, or a word from a class that is genuinely closed.
 *
 * This is the inversion of the test it replaces, and the inversion is the fix.
 * That one listed the *nouns* `minor` could be modifying and asked that none of
 * them follow — and the nouns a filter might reach for are not a closed class,
 * so the list was a guess that had to be right forever. It was already wrong
 * about every plural of its own entries: `\b` had to fall immediately after the
 * singular, so `"minor variation"` was the adjective and `"minor variations"`
 * was a child, and `changes`, `details`, `differences`, `versions`,
 * `references`, `tweaks`, `edits`, `revisions`, `issues`, `points`,
 * `deviations`, `elements`, `roles` and `parts` all escaped the same way — the
 * veto firing on ordinary intellectual-property English and taking the
 * copyright rewrite with it.
 *
 * Asking instead whether `minor` is the *head* of its noun phrase needs no list
 * of nouns and no list of inflections: a head noun is followed by a preposition,
 * a copula, a coordinator, a relative pronoun, a mark or nothing, and that is
 * the whole of it.
 * Anything else means a noun is standing behind it, and a `minor` with a noun
 * behind it is the adjective.
 *
 * The direction it is wrong in is the cheap one, which is the same direction the
 * old list chose deliberately: a following word that is neither reads as the
 * adjective, so an unusual phrasing costs one rewritten prompt that comes back
 * refused identically — never a picture nobody may ask for again. A hyphen is
 * excluded from the punctuation for that reason: "a minor-league mascot" is a
 * compound adjective, and nothing spells a child that way.
 *
 * The coordinators are the one entry that is not free, and they are here
 * because leaving them out would have been a *new* hole in the veto rather than
 * a kept one: "the abuse of a minor and a copyrighted character" is a child by
 * every reading, and `and` follows a head noun as readily as `of` does. What it
 * costs is the mirror phrase, "would exploit minor and major elements of a
 * copyrighted design" — a coordinated *adjective*, and the only shape left that
 * still vetoes ordinary intellectual-property English.
 */
const HEAD_NOUN_TAIL = String.raw`(?:of|in|on|at|for|from|to|with|by|under|within|into|about|against|involving|alongside|among|between|during|near|over|and|or|nor|who|whom|whose|that|which|is|are|was|were|be|been|being|am|get|gets|got|getting|has|have|had|do|does|did|will|would|can|could|may|might|must|should)`;

/**
 * The one thing a person `minor` may stand in front of: another word for the
 * same person. "A minor girl being abused" is a child by the grammar below, and
 * the head-noun test would otherwise read `girl` as the noun and `minor` as its
 * size. Kept separate from {@link PROTECTED_PERSON_NOUN}, which offers
 * `character`, `figure`, `model` and `subject` as well — those are exactly the
 * words a *rights-holder* reading uses, and "a minor character" has to stay the
 * small part it usually is.
 */
const MINOR_PERSON_NOUN = String.raw`(?:child(?:ren)?|boys?|girls?|kids?|teens?|persons?|people|individuals?|humans?)`;

/**
 * Who the filter means by a protected person.
 *
 * Plural `minors` is only ever the noun. Singular `minor` is the adjective at
 * least as often — "a minor variation", "a minor character from the film" — so
 * it counts as a person only where it heads its own noun phrase. The grammar
 * below is what does the work; this is the belt beside it. Reading `a minor
 * character` as the small part it usually is costs nothing, because a refusal
 * that really meant a child there says so in another word too — `sexual`,
 * `nudity`, `abuse of a child`, the filter's own label — and every one of those
 * fires on its own.
 *
 * Nothing wider is here for a reason. Widening the person vocabulary widens the
 * veto in the safe direction only until it meets a franchise name: `teen` reads
 * "Teen Titans" and `kid` reads "Kid Flash", which are protected names — the
 * one thing a rewrite is *for*. (`teen` and `kid` are reachable from
 * {@link MINOR_PERSON_NOUN}, but only behind an explicit `minor`, where no
 * franchise name puts them.)
 */
const PROTECTED_PERSON = String.raw`(?:child(?:ren)?|minors|minor(?=\s*$|[^\w\s-]|\s+(?:${HEAD_NOUN_TAIL}|${MINOR_PERSON_NOUN})\b)|under-?age|adolescents?)`;

/**
 * A common noun the person word may be standing in front of, so that "an
 * underage character being exploited" is read the same as "an underage person
 * being exploited". It is offered only on the subject side: on the object side
 * "exploitation of the trademarked character" is the false veto this all exists
 * to prevent, and no noun may be skipped there.
 */
const PROTECTED_PERSON_NOUN = String.raw`(?:\s+(?:characters?|figures?|persons?|people|individuals?|boys?|girls?|kids?|models?|subjects?))?`;

/** The harm, in the words a child-safety filter uses for it. */
const CHILD_HARM = String.raw`(?:abus\w*|exploit\w*|endanger\w*)`;

/**
 * What may sit between the harm word and the person it is done to: one
 * preposition, one determiner, one modifier — and nothing open-ended, because
 * an open window is exactly what read "exploitation of the trademarked
 * children's franchise" as the exploitation of children.
 */
const HARM_OBJECT_GAP = String.raw`(?:\s+(?:of|on|against|involving|toward|towards|upon|to))?(?:\s+(?:a|an|the|any|all|such|these|those|our|their))?(?:\s+(?:young|younger|little|small|real|actual|vulnerable|innocent|depicted|fictional|under-?age|minor))?\s+`;

/**
 * And between the person and a harm done *to* them: only the copular and
 * relative skeleton that makes it a predicate. Anything else is a different
 * clause, which is how "a child to read, as this would exploit a copyrighted
 * character" ever counted.
 */
const HARM_SUBJECT_GAP = String.raw`(?:\s+(?:who|whom|that|which|is|are|was|were|being|been|be|get|gets|got|getting))*\s+`;

/**
 * The words a filter reaches for when it is *asserting* a block, as opposed to
 * the words a picture can simply be of.
 *
 * The decline is deliberately not among them. Every native refusal opens with
 * one ("I can't create…"), so a frame that counted it would be no frame at all
 * — which is the whole failure mode this exists to close.
 */
const FILTER_ASSERTION = String.raw`(?:polic(?:y|ies)|guidelines?|violat\w*|block\w*|refus\w*|declin\w*|reject\w*|prohibit\w*|disallow\w*|restrict\w*|flagg?ed|filters?|filtered|categor(?:y|ies)|classifier|concerns?|not\s+(?:permitted|allowed))`;

/**
 * The same word, read only where the filter's own statement puts it — in
 * either order, and never across the end of a sentence.
 *
 * This is `imagenNamedCategories`' rule one module over, said as a function: a
 * category counts when the filter *wrote it into its own statement about this
 * request*, and not when a score table or a restated scene merely contains it.
 * The bound is `[^.!?]{0,60}`, the same one
 * `FILTER_VOCABULARY_EVIDENCE` next door uses, so `"…refused the prompt (IMAGE_SAFETY). I can't create an image of
 * Bluey teaching child safety…"` cannot reach across the full stop and read
 * the wrapper's own `refused` as the frame for the scene's own words.
 */
function assertedByFilter(subject: string): RegExp[] {
  return [
    new RegExp(String.raw`\b${FILTER_ASSERTION}\b[^.!?]{0,60}\b${subject}`, "i"),
    new RegExp(String.raw`\b${subject}[^.!?]{0,60}\b${FILTER_ASSERTION}\b`, "i")
  ];
}

/**
 * The half of the filter's compound label whose *scene* reading is the harm
 * itself, so it needs no frame: a picture of child abuse is the thing being
 * refused, not a thing a book asks for by accident.
 *
 * The trailing `\w*` rather than `\b` is what lets a code echoed into prose
 * match: `_` is a word character, so `child_sexual_abuse_material` has no word
 * boundary after `abuse` to end on. `minors` only — "a minor abuse of the
 * trademark" is ordinary English.
 */
const CHILD_HARM_LABEL = String.raw`(?:child(?:ren)?|minors)[\s_-]*(?:sexual\w*[\s_-]*)?(?:abuse|exploitation|endangerment)\w*`;

/**
 * And the half that is an ordinary children's-book subject.
 *
 * `"I can't create an image of Bluey teaching child safety at a crossing."` is
 * the native model restating a request about a franchise name, and `"a child
 * protection poster"` is a thing a book is *for*. Read bare, this label vetoed
 * both: `isNeverRewritableRefusal` answered true, the category went to `other`,
 * and a refusal purely about a protected name was permanently denied the one
 * rewrite that could have answered it — the same silent short-circuit as the
 * `/child|minor/` bug, one pattern further in, and the `codes` half of this
 * same rule would not have vetoed either of them.
 *
 * So it counts only where {@link assertedByFilter} puts a filter's own
 * assertion beside it ("blocked for child safety", "violates our child safety
 * policy", "due to child safety concerns"), or in the underscore spelling no
 * sentence writes. Nothing genuine is lost by that: a provider that means this
 * category says so in its `reason` too, and {@link NEVER_REWRITABLE_CODE} is a
 * bare word test over exactly that — a second door onto the same verdict, which
 * is what makes the frame affordable here and not on the copyright side above.
 */
const CHILD_PROTECTION_LABEL = String.raw`(?:child(?:ren)?|minors)[\s_-]*(?:safety|protection)\w*`;

/** Over prose, where only a filter's own vocabulary counts as the filter speaking. */
const NEVER_REWRITABLE_VOCABULARY = [
  // Harm words that describe no illustration a book ever asked for.
  /\b(?:csam|nsfw|nudity|nude|sexual\w*|pornograph\w*)\b/i,
  /\bexplicit\s+(?:content|material|imagery|images?)\b/i,
  // The filter's own compound label, however it is punctuated — the half that
  // stands alone, and `child sexual …` under any spelling, including the
  // underscore form where no `\b` ever falls after `sexual`.
  new RegExp(String.raw`\b${CHILD_HARM_LABEL}`, "i"),
  /\b(?:child(?:ren)?|minors)[\s_-]*sexual\w*/i,
  // The ambiguous half: the code spelling stands alone, the prose spelling
  // needs the filter's own assertion around it.
  /\b(?:child(?:ren)?|minors)_+(?:safety|protection)/i,
  ...assertedByFilter(CHILD_PROTECTION_LABEL),
  // The category naming its subject the other way round.
  new RegExp(String.raw`\b(?:safety|protection)\s+of\s+(?:a\s+|an\s+|the\s+|any\s+|our\s+)?${PROTECTED_PERSON}\b`, "i"),
  // The harm taking the protected person as its object, and the protected
  // person as the subject of the harm. Nothing else is the filter speaking.
  new RegExp(String.raw`\b${CHILD_HARM}${HARM_OBJECT_GAP}${PROTECTED_PERSON}\b`, "i"),
  new RegExp(String.raw`\b${PROTECTED_PERSON}${PROTECTED_PERSON_NOUN}${HARM_SUBJECT_GAP}${CHILD_HARM}\b`, "i")
];

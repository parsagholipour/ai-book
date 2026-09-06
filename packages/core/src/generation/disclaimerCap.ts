/** Read-only phrase measurement for historical scorecards. These phrases can express essential uncertainty. */
const DISCLAIMER_VERB =
  /(cannot|can't|could not|does not|do not|did not|will not|would not|rarely|never|no longer|hardly)\s+(\w+\s+){0,3}?(show|shows|establish|establishes|tell|tells|reveal|reveals|record|records|prove|proves|settle|settles|supply|supplies|answer|answers|explain|explains|identify|identifies|preserve|preserves|register|registers|measure|measures|guarantee|guarantees|say|says|determine|determines|capture|captures|disclose|discloses|indicate|indicates|specify|specifies|name|names)\b/i;

const DISCLAIMER_PHRASE =
  /more securely than|less securely than|offers? no\b|leaves? (open|unresolved|undecided|unanswered)|is (limited|silent|weakest|strongest) (at|on|about)|beyond (its|their|the) (record|reach|evidence)|remains? (unknown|uncertain|unresolved|beyond)|what (it|they|the \w+) cannot\b/i;

/** A sentence whose work is to say what the material does not do. */
export function isDisclaimerSentence(sentence: string): boolean {
  return DISCLAIMER_VERB.test(sentence) || DISCLAIMER_PHRASE.test(sentence);
}

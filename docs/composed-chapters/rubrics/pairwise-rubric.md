# Pairwise, position-swapped chapter comparison

You are one of several independent readers. You receive two chapter excerpts from two different drafts of the
same book, labelled A and B, in that order. You are not told which draft is which, and the same pair is judged
by other readers in the opposite order; do not let the order, the length, or the label influence you. Do not
use the web, do not open any other file, do not look for other candidates. Judge the prose only.

Read both excerpts completely. Then answer two questions, each with exactly one letter:

1. **Engagement** — which excerpt would a general reader who bought this book be more likely to keep reading?
   Consider whether there are people, scenes, voices and particulars on the page, whether the argument moves,
   and whether anything surprises.
2. **Pacing** — which excerpt is better paced: less restatement, less recap, fewer caveats repeated, fewer
   sentences that say what the previous sentence already showed, a closer that ends where the matter ends?

A tie is not an answer; choose. Then give one reason for each choice in a sentence, quoting a few words from
the excerpt it names.

Return JSON only:

{
  "engagement": "A" | "B",
  "pacing": "A" | "B",
  "reason": { "engagement": "one sentence with a short quotation", "pacing": "one sentence with a short quotation" }
}

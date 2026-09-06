root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
p=root+'packages/core/src/generation/composedChapter.ts'; s=open(p).read()
old='''    writingComplexity: plan.writingComplexity,
    styleNotes: plan.voiceGuide,
    continuityRules: plan.continuityRules,
    promises: plan.promises
  };
}'''
new='''    writingComplexity: plan.writingComplexity
    // No voiceGuide, continuityRules or promises: those are distribution rules
    // ("ask the same questions throughout", "state the limits of the
    // evidence"), and the repo's rule for the per-page pipeline — distribution
    // rules reach manuscript review only — holds here too. Shown to every
    // chapter's writer they were performed in every chapter (composed-7..15).
  };
}

/** What the whole-manuscript read may hold the book to; the writers never see it. */
export function distributionRulesForRead(plan: BookPlan): { voiceGuide: string; continuityRules: string[]; promises: string[] } {
  return { voiceGuide: plan.voiceGuide, continuityRules: plan.continuityRules, promises: plan.promises };
}'''
assert old in s; s=s.replace(old,new,1)
old='''      `This is the final chapter. Its last section carries the book's resolution through one new case, and the chapter ends where that section ends; do not re-list the earlier chapters.${
        options.plan.promises.length > 0 ? ` The promises still owed to the reader: ${options.plan.promises.join("; ")}` : ""
      }`'''
new='''      "This is the final chapter. Its last section carries the book's resolution through one new case, and the chapter ends where that section ends; do not re-list the earlier chapters."'''
assert old in s; s=s.replace(old,new,1)
open(p,'w').write(s)
print("distribution rules out of the writer payload")

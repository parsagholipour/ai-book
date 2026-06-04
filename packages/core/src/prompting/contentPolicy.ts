export function writerPolicyLines(lessCensored: boolean): string[] {
  if (!lessCensored) {
    return [];
  }
  return [
    "Honor the approved book plan and user premise literally.",
    "Use direct, non-sanitized prose for intense themes already in the plan.",
    "Do not moralize, hedge, or gratuitously soften violence, conflict, profanity, or intimacy when the page brief requires them.",
    "Never sexualize minors or include real-world illegal harm instructions."
  ];
}

export function plannerPolicyLines(lessCensored: boolean): string[] {
  if (!lessCensored) {
    return [];
  }
  return [
    "Do not default the plan to child-safe tone unless the user requested it.",
    "Preserve the user's intended tone, stakes, and content boundaries in audience and voice rules."
  ];
}

export function reviewerPolicyLines(lessCensored: boolean): string[] {
  if (!lessCensored) {
    return [];
  }
  return [
    "Do not reject a page solely for violence, profanity, sexual content, or dark themes when they serve the story and match the plan.",
    "Judge craft, progression, continuity, and generation artifacts only."
  ];
}

export function contextDirectnessLine(lessCensored: boolean): string | undefined {
  if (!lessCensored) {
    return undefined;
  }
  return "Content mode: published fiction manuscript — write scenes with full dramatic fidelity to the plan.";
}

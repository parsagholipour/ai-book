/**
 * The console's copy of the release list `/api/admin/app-updates` stores.
 * The server decides what a build is asked (`decideAppUpdate` in
 * apps/api/src/appUpdates.ts); this file only says it back to the operator.
 */

export const APP_UPDATE_PLATFORMS = ["android", "ios"] as const;
export const APP_UPDATE_POLICIES = ["silent", "prompt", "required"] as const;

export type AppUpdatePlatform = (typeof APP_UPDATE_PLATFORMS)[number];
export type AppUpdatePolicy = (typeof APP_UPDATE_POLICIES)[number];

export type AppUpdateRelease = {
  platform: AppUpdatePlatform;
  build: number;
  version: string;
  policy: AppUpdatePolicy;
  message?: string;
};

export type AppUpdates = {
  version: number;
  releases: AppUpdateRelease[];
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

export const PLATFORM_LABELS: Record<AppUpdatePlatform, string> = {
  android: "Android",
  ios: "iOS"
};

export const POLICY_LABELS: Record<AppUpdatePolicy, string> = {
  silent: "Silent — nothing shown",
  prompt: "Ask — dismissible prompt",
  required: "Require — blocks the app"
};

export type PlatformEffect = {
  platform: AppUpdatePlatform;
  latest: AppUpdateRelease;
  /** Builds below this are blocked; null when no release requires. */
  requiredBelow: number | null;
  /** Builds below this (and not blocked) are asked; null when no newer release prompts. */
  promptBelow: number | null;
};

/**
 * One release's policy covers every build older than it, so a platform's whole
 * list reduces to two thresholds: the newest `required` build and the newest
 * `prompt` build above it.
 */
export function platformEffects(releases: readonly AppUpdateRelease[]): PlatformEffect[] {
  return APP_UPDATE_PLATFORMS.flatMap((platform) => {
    const own = releases.filter((release) => release.platform === platform).sort((a, b) => b.build - a.build);
    const latest = own[0];
    if (!latest) return [];
    const required = own.find((release) => release.policy === "required")?.build ?? null;
    const prompt = own.find((release) => release.policy === "prompt")?.build ?? null;
    return [
      {
        platform,
        latest,
        requiredBelow: required,
        promptBelow: prompt !== null && (required === null || prompt > required) ? prompt : null
      }
    ];
  });
}

/** Trims messages and drops empty ones, so an untouched row compares equal to the stored one. */
export function normalizeReleases(releases: readonly AppUpdateRelease[]): AppUpdateRelease[] {
  return [...releases]
    .map(({ message, ...release }) => {
      const trimmed = message?.trim();
      return { ...release, version: release.version.trim(), ...(trimmed ? { message: trimmed } : {}) };
    })
    .sort((left, right) => left.platform.localeCompare(right.platform) || right.build - left.build);
}

export function releasesDiffer(left: readonly AppUpdateRelease[], right: readonly AppUpdateRelease[]): boolean {
  return JSON.stringify(normalizeReleases(left)) !== JSON.stringify(normalizeReleases(right));
}

/** Why a new row cannot be added, or null when it can. */
export function newReleaseProblem(
  releases: readonly AppUpdateRelease[],
  candidate: { platform: AppUpdatePlatform; build: string; version: string }
): string | null {
  const build = Number(candidate.build);
  if (!/^\d+$/.test(candidate.build.trim()) || !Number.isSafeInteger(build) || build < 1) {
    return "The build number is the whole-number versionCode, e.g. 7.";
  }
  if (!candidate.version.trim()) {
    return "Give the version name readers see, e.g. 1.2.0.";
  }
  if (releases.some((release) => release.platform === candidate.platform && release.build === build)) {
    return `${PLATFORM_LABELS[candidate.platform]} build ${build} is already listed.`;
  }
  return null;
}

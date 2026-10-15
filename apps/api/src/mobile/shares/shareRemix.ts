import { isUltraTierEnabled, jsonRecord, maxGeneratedBookPages, modelTierSchema } from "@book-maker/core";
import { inferBookType, mobileMetadataFromMediaSettings } from "../projectSummarySerializers.js";
import { imageSettingsFromMediaSettings } from "../imageSettings.js";
import type { MobileCreationPresetsInput } from "../../mobileCreation.js";

/**
 * "Make a book like this": the shared book's **format**, never its content.
 *
 * The answer is exactly a `mobileCreationPresetsInputSchema` value — book type,
 * length, quality, cover and illustration switches, page count — which the app
 * applies to a new creation chat. The brief, the plan, the chat, the cast and
 * the page text stay on the author's side of the link: none of them is read
 * here, so none of them can leak through a later edit of this function.
 */
export type MobileShareRemixDto = {
  title: string;
  presets: MobileCreationPresetsInput;
};

export function remixPresetsForProject(project: {
  mediaSettings: unknown;
  category: string;
  subcategory: string | null;
  targetPages: number;
}): MobileCreationPresetsInput {
  const echoed = mobileMetadataFromMediaSettings(project.mediaSettings);
  const images = imageSettingsFromMediaSettings(project.mediaSettings);
  const inferred = inferBookType(project.category, project.subcategory);
  const bookType = echoed && echoed.bookType !== "custom" ? echoed.bookType : inferred === "custom" ? "lead_magnet" : inferred;
  const tier = modelTierSchema.safeParse(jsonRecord(project.mediaSettings).modelTier);
  const sharedQuality = echoed?.qualityPreset ?? (tier.success ? tier.data : "balanced");
  // The format is offered as something the remixer can start today: an Ultra
  // book is copied at Premium while the operator has Ultra off, and a book
  // longer than every generated book may be is copied at the ceiling —
  // otherwise the new chat's Build would refuse its own preset.
  const qualityPreset = sharedQuality === "ultra" && !isUltraTierEnabled() ? "premium" : sharedQuality;
  const targetPages = Math.min(maxGeneratedBookPages(), Math.max(1, Math.floor(project.targetPages || 1)));
  return {
    bookType,
    // "auto" would let the new chat re-derive the type and lose the format
    // being copied; only a concrete choice travels.
    ...(echoed?.bookTypeChoice && echoed.bookTypeChoice !== "auto" ? { bookTypeChoice: echoed.bookTypeChoice } : {}),
    lengthPreset: echoed && echoed.lengthPreset !== "custom" ? echoed.lengthPreset : "standard",
    qualityPreset,
    coverEnabled: images.coverEnabled,
    illustrationsEnabled: images.illustrationsEnabled,
    // The page count is part of the format: a remix of a 24-page picture book
    // starts at 24 pages, and the reader can still change it in the chat.
    pageCountMode: "custom",
    targetPages,
    pageCountSource: "settings"
  };
}

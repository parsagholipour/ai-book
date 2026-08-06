import { coverArtSourceFor, mediaSettingsSchema, type CoverArtSource } from "@book-maker/core";
import { jsonRecord } from "./support.js";

export type MobileImageSettings = {
  coverEnabled: boolean;
  illustrationsEnabled: boolean;
  imagesEnabled: boolean;
  coverArtSource: CoverArtSource;
};

/**
 * Reads the exact image choices from canonical project media settings.
 *
 * `coverEnabled` means "a model drew the cover", which is what it has always
 * priced — a book with `coverArtSource: "design"` gets a real cover for free
 * and still reports `coverEnabled: false`, so the shipped credit mirror in the
 * app keeps quoting the right number.
 */
export function imageSettingsFromMediaSettings(mediaSettings: unknown): MobileImageSettings {
  const settings = jsonRecord(mediaSettings);
  const coverArtSource = coverArtSourceFor({
    includeCover: typeof settings.includeCover === "boolean" ? settings.includeCover : true,
    ...(mediaSettingsSchema.shape.coverArtSource.safeParse(settings.coverArtSource).success
      ? { coverArtSource: settings.coverArtSource as CoverArtSource }
      : {})
  });
  const coverEnabled = coverArtSource === "ai";
  const illustrationsEnabled =
    typeof settings.fullIllustrations === "boolean" ? settings.fullIllustrations : true;
  return {
    coverEnabled,
    illustrationsEnabled,
    imagesEnabled: coverEnabled || illustrationsEnabled,
    coverArtSource
  };
}

import { jsonRecord } from "./support.js";

export type MobileImageSettings = {
  coverEnabled: boolean;
  illustrationsEnabled: boolean;
  imagesEnabled: boolean;
};

/** Reads the exact image choices from canonical project media settings. */
export function imageSettingsFromMediaSettings(mediaSettings: unknown): MobileImageSettings {
  const settings = jsonRecord(mediaSettings);
  const coverEnabled = typeof settings.includeCover === "boolean" ? settings.includeCover : true;
  const illustrationsEnabled =
    typeof settings.fullIllustrations === "boolean" ? settings.fullIllustrations : true;
  return {
    coverEnabled,
    illustrationsEnabled,
    imagesEnabled: coverEnabled || illustrationsEnabled
  };
}

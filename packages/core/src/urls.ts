export function publicAssetUrl(publicApiUrl: string, assetPath: string): string {
  if (/^https?:\/\//i.test(assetPath)) {
    return assetPath;
  }
  const base = publicApiUrl.replace(/\/+$/, "");
  const path = assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
  return `${base}${path}`;
}

export function resolvePublicImageUrl(
  path: string | null | undefined,
  publicApiUrl: string
): string | undefined {
  if (!path) {
    return undefined;
  }
  return publicAssetUrl(publicApiUrl, path);
}

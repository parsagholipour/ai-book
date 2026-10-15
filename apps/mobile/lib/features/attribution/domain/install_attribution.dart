/// Where this install came from, as the Play install referrer said.
///
/// A Play Store link can carry a `referrer` query, and Play hands it to the
/// app it installs. A shared book's page links to Play with
/// `utm_source=share&utm_content=<slug>` (`playStoreUrl` in
/// `apps/api/src/mobile/shares/sharePage.ts`); Play's own organic installs say
/// `utm_source=google-play&utm_medium=organic`. Only the three `utm_` fields
/// and a share's slug are kept: the raw string can carry anything the link's
/// author put there (an ad click id, free text), and none of that leaves the
/// phone.
class InstallAttribution {
  const InstallAttribution({
    required this.source,
    required this.medium,
    this.campaign,
    this.shareSlug,
  });

  /// `utm_source`, normalised by [attributionToken]; `unknown` when absent.
  final String source;

  /// `utm_medium`, normalised; `none` when absent.
  final String medium;
  final String? campaign;

  /// The share page the install came from, when it came from one.
  final String? shareSlug;

  /// The `POST /api/mobile/events` body; `productEventFromBody` in
  /// `apps/api/src/mobile/productEventBody.ts` reads it.
  Map<String, Object> toEventJson() => {
    'name': 'install_attributed',
    'source': source,
    'medium': medium,
    'campaign': ?campaign,
    'shareSlug': ?shareSlug,
  };

  Map<String, Object> toJson() => {
    'source': source,
    'medium': medium,
    'campaign': ?campaign,
    'shareSlug': ?shareSlug,
  };

  static InstallAttribution? fromJson(Object? json) {
    if (json is! Map) return null;
    final source = attributionToken(json['source'] as String?);
    if (source == null) return null;
    final slug = json['shareSlug'];
    return InstallAttribution(
      source: source,
      medium: attributionToken(json['medium'] as String?) ?? 'none',
      campaign: attributionToken(json['campaign'] as String?),
      shareSlug: slug is String && shareSlugPattern.hasMatch(slug)
          ? slug
          : null,
    );
  }
}

/// `utm_source` of a shared book's Play link.
const shareReferrerSource = 'share';

/// Mirrors `SHARE_SLUG_PATTERN` in `apps/api/src/mobile/shares/shareSlug.ts`.
final shareSlugPattern = RegExp(r'^[0-9A-Za-z]{10,32}$');

/// What the referrer [referrer] says, or null when there is none to read.
///
/// Never throws: a referrer that will not parse is one this install has no
/// attribution for.
InstallAttribution? parseInstallReferrer(String? referrer) {
  var text = referrer?.trim() ?? '';
  if (text.isEmpty) return null;
  // Play returns the referrer decoded once. A link that encoded it twice
  // still arrives as `utm_source%3Dshare%26…`.
  if (!text.contains('=') && text.toUpperCase().contains('%3D')) {
    try {
      text = Uri.decodeComponent(text);
    } on Object {
      return null;
    }
  }
  final Map<String, String> query;
  try {
    query = Uri.splitQueryString(text);
  } on Object {
    return null;
  }
  final source = attributionToken(query['utm_source']) ?? 'unknown';
  final content = query['utm_content']?.trim();
  return InstallAttribution(
    source: source,
    medium: attributionToken(query['utm_medium']) ?? 'none',
    campaign: attributionToken(query['utm_campaign']),
    shareSlug:
        source == shareReferrerSource &&
            content != null &&
            shareSlugPattern.hasMatch(content)
        ? content
        : null,
  );
}

/// One referrer field as the server accepts it
/// (`INSTALL_ATTRIBUTION_TOKEN_PATTERN` in `apps/api/src/productEventNames.ts`):
/// lower case, nothing but `[a-z0-9._-]`, starting with a letter or digit, at
/// most 40 characters. Null when nothing is left.
String? attributionToken(String? value) {
  if (value == null) return null;
  var token = value
      .trim()
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9._-]+'), '-')
      .replaceFirst(RegExp(r'^[^a-z0-9]+'), '');
  if (token.length > 40) token = token.substring(0, 40);
  return token.isEmpty ? null : token;
}

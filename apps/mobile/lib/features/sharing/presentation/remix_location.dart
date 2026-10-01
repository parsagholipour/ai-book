/// Where "Make a book like this" lands inside the app.
///
/// A shared book's page links to `tomeza://remix/<slug>` (as an Android intent
/// URL). Flutter hands the router that whole URI, scheme and host included,
/// and the router's top-level redirect sees it before any route is matched —
/// so the redirect is where it becomes an ordinary `/remix/<slug>` location.
library;

const remixDeepLinkScheme = 'tomeza';
const remixDeepLinkHost = 'remix';

/// The in-app location of the remix screen for [slug].
String remixLocation(String slug) => '/remix/${Uri.encodeComponent(slug)}';

/// Where a `tomeza://remix/<slug>` link goes, or null when [uri] is not one.
///
/// A link that names no slug still opened the app on purpose, so it lands on
/// a new book rather than on the "screen not found" page.
String? remixLocationForDeepLink(Uri uri) {
  if (uri.scheme != remixDeepLinkScheme || uri.host != remixDeepLinkHost) {
    return null;
  }
  for (final segment in uri.pathSegments) {
    if (segment.isNotEmpty) return remixLocation(segment);
  }
  return '/home';
}

/// The slug a `/remix/<slug>` [path] carries, or null for any other path.
String? remixSlugFromPath(String path) {
  final segments = Uri(path: path).pathSegments;
  if (segments.length != 2 || segments.first != 'remix') return null;
  final slug = segments.last;
  return slug.isEmpty ? null : slug;
}

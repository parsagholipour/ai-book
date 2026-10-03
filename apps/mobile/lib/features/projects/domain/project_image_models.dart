/// A picture of a book as the server serves it: its cover, a page's visual or a
/// character's portrait.
class MobileProjectImage {
  const MobileProjectImage({
    required this.id,
    required this.role,
    required this.url,
    required this.contentType,
    required this.altText,
    this.pageId,
    this.aiGenerated = true,
  });

  final String id;
  final String role;
  final String url;
  final String contentType;
  final String altText;
  final String? pageId;

  /// Whether a model drew it. A designed cover and an author's own upload are
  /// not AI content, so they get no "Report visual". A server that does not
  /// send the field reads as `true`, which keeps every picture reportable.
  final bool aiGenerated;

  factory MobileProjectImage.fromJson(Map<String, dynamic> json) {
    return MobileProjectImage(
      id: json['id'] as String,
      role: json['role'] as String,
      url: json['url'] as String,
      contentType: json['contentType'] as String,
      altText: json['altText'] as String,
      pageId: json['pageId'] as String?,
      aiGenerated: json['aiGenerated'] as bool? ?? true,
    );
  }
}

// Compiled book downloads: what the server is offering, and what has been
// written to the device.
//
// Split out of `project_models.dart` because the reader depends on these
// alone, without the plan, chat and status models around them.

class MobileExportSet {
  const MobileExportSet({required this.pdf, required this.epub});

  final MobileExportAvailability pdf;
  final MobileExportAvailability epub;

  factory MobileExportSet.fromJson(Map<String, dynamic> json) {
    return MobileExportSet(
      pdf: MobileExportAvailability.fromJson(
        json['pdf'] as Map<String, dynamic>,
      ),
      epub: MobileExportAvailability.fromJson(
        json['epub'] as Map<String, dynamic>,
      ),
    );
  }
}

class MobileExportAvailability {
  const MobileExportAvailability({
    required this.format,
    required this.available,
    required this.unlocked,
    required this.creditsRequired,
    required this.downloadUrl,
    required this.filename,
    required this.contentType,
    this.revision = 0,
    this.byteSize,
    this.updatedAt,
  });

  final String format;
  final bool available;
  final bool unlocked;
  final int creditsRequired;
  final String downloadUrl;
  final String filename;
  final String contentType;

  /// Project content revision this availability was reported against.
  final int revision;

  /// Size of the compiled file, or null when it has not been compiled.
  final int? byteSize;

  /// When the compiled file was last written, or null when absent.
  final DateTime? updatedAt;

  factory MobileExportAvailability.fromJson(Map<String, dynamic> json) {
    final updatedAt = json['updatedAt'] as String?;
    return MobileExportAvailability(
      format: json['format'] as String,
      available: json['available'] as bool,
      unlocked: json['unlocked'] as bool,
      creditsRequired: json['creditsRequired'] as int,
      downloadUrl: json['downloadUrl'] as String,
      filename: json['filename'] as String,
      contentType: json['contentType'] as String,
      revision: json['revision'] as int? ?? 0,
      byteSize: json['byteSize'] as int?,
      updatedAt: updatedAt == null ? null : DateTime.tryParse(updatedAt),
    );
  }
}

class ProjectExportFile {
  const ProjectExportFile({
    required this.format,
    required this.filename,
    required this.path,
  });

  final String format;
  final String filename;
  final String path;
}

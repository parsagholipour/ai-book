class MobileProjectSummary {
  const MobileProjectSummary({
    required this.id,
    required this.title,
    required this.bookType,
    required this.lengthPreset,
    required this.qualityPreset,
    required this.imagesEnabled,
    required this.status,
    required this.statusLabel,
    required this.progressPercent,
    required this.currentAction,
    required this.promptPreview,
    required this.targetPages,
    required this.pageCount,
    required this.imageCount,
    required this.hasPlan,
    required this.exports,
    required this.createdAt,
    required this.updatedAt,
    this.subtitle,
    this.authorName,
  });

  final String id;
  final String title;
  final String? subtitle;
  final String? authorName;
  final String bookType;
  final String lengthPreset;
  final String qualityPreset;
  final bool imagesEnabled;
  final String status;
  final String statusLabel;
  final int progressPercent;
  final String currentAction;
  final String promptPreview;
  final int targetPages;
  final int pageCount;
  final int imageCount;
  final bool hasPlan;
  final MobileExportSet exports;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory MobileProjectSummary.fromJson(Map<String, dynamic> json) {
    return MobileProjectSummary(
      id: json['id'] as String,
      title: json['title'] as String,
      subtitle: json['subtitle'] as String?,
      authorName: json['authorName'] as String?,
      bookType: json['bookType'] as String,
      lengthPreset: json['lengthPreset'] as String,
      qualityPreset: json['qualityPreset'] as String,
      imagesEnabled: json['imagesEnabled'] as bool,
      status: json['status'] as String,
      statusLabel: json['statusLabel'] as String,
      progressPercent: json['progressPercent'] as int,
      currentAction: json['currentAction'] as String,
      promptPreview: json['promptPreview'] as String,
      targetPages: json['targetPages'] as int,
      pageCount: json['pageCount'] as int,
      imageCount: json['imageCount'] as int,
      hasPlan: json['hasPlan'] as bool,
      exports: MobileExportSet.fromJson(
        json['exports'] as Map<String, dynamic>,
      ),
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }

  String get bookTypeLabel {
    return switch (bookType) {
      'lead_magnet' => 'Lead magnet',
      'workbook' => 'Workbook',
      'short_story' => 'Short story',
      _ => 'Book',
    };
  }

  bool get hasReadyExport => exports.pdf.available || exports.epub.available;
}

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
  });

  final String format;
  final bool available;
  final bool unlocked;
  final int creditsRequired;
  final String downloadUrl;
  final String filename;
  final String contentType;

  factory MobileExportAvailability.fromJson(Map<String, dynamic> json) {
    return MobileExportAvailability(
      format: json['format'] as String,
      available: json['available'] as bool,
      unlocked: json['unlocked'] as bool,
      creditsRequired: json['creditsRequired'] as int,
      downloadUrl: json['downloadUrl'] as String,
      filename: json['filename'] as String,
      contentType: json['contentType'] as String,
    );
  }
}

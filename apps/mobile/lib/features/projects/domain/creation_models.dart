import 'project_models.dart';

class MobileCreationOptionalDetails {
  const MobileCreationOptionalDetails({
    this.title = '',
    this.authorName = '',
    this.mustInclude = '',
    this.tone = '',
  });

  final String title;
  final String authorName;
  final String mustInclude;
  final String tone;

  factory MobileCreationOptionalDetails.fromJson(Map<String, dynamic> json) {
    return MobileCreationOptionalDetails(
      title: json['title'] as String? ?? '',
      authorName: json['authorName'] as String? ?? '',
      mustInclude: json['mustInclude'] as String? ?? '',
      tone: json['tone'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      if (title.trim().isNotEmpty) 'title': title.trim(),
      if (authorName.trim().isNotEmpty) 'authorName': authorName.trim(),
      'mustInclude': mustInclude.trim(),
      'tone': tone.trim(),
    };
  }

  bool get hasContent =>
      title.trim().isNotEmpty ||
      authorName.trim().isNotEmpty ||
      mustInclude.trim().isNotEmpty ||
      tone.trim().isNotEmpty;
}

class MobileBookRecipe {
  const MobileBookRecipe({
    required this.lane,
    this.title = '',
    this.artifact = '',
    this.audience = '',
    this.promise = '',
    this.tone = '',
    this.mainCharacter = '',
    this.conflict = '',
    this.ending = '',
    this.theme = '',
    this.nextStep = '',
    this.exercises = '',
    this.mustInclude = '',
  });

  final String lane;
  final String title;
  final String artifact;
  final String audience;
  final String promise;
  final String tone;
  final String mainCharacter;
  final String conflict;
  final String ending;
  final String theme;
  final String nextStep;
  final String exercises;
  final String mustInclude;

  factory MobileBookRecipe.fromJson(Map<String, dynamic> json) {
    return MobileBookRecipe(
      lane: json['lane'] as String? ?? 'auto',
      title: json['title'] as String? ?? '',
      artifact: json['artifact'] as String? ?? '',
      audience: json['audience'] as String? ?? '',
      promise: json['promise'] as String? ?? '',
      tone: json['tone'] as String? ?? '',
      mainCharacter: json['mainCharacter'] as String? ?? '',
      conflict: json['conflict'] as String? ?? '',
      ending: json['ending'] as String? ?? '',
      theme: json['theme'] as String? ?? '',
      nextStep: json['nextStep'] as String? ?? '',
      exercises: json['exercises'] as String? ?? '',
      mustInclude: json['mustInclude'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'lane': lane,
      'title': title.trim(),
      'artifact': artifact.trim(),
      'audience': audience.trim(),
      'promise': promise.trim(),
      'tone': tone.trim(),
      'mainCharacter': mainCharacter.trim(),
      'conflict': conflict.trim(),
      'ending': ending.trim(),
      'theme': theme.trim(),
      'nextStep': nextStep.trim(),
      'exercises': exercises.trim(),
      'mustInclude': mustInclude.trim(),
    };
  }

  MobileBookRecipe copyWith({
    String? lane,
    String? title,
    String? artifact,
    String? audience,
    String? promise,
    String? tone,
    String? mainCharacter,
    String? conflict,
    String? ending,
    String? theme,
    String? nextStep,
    String? exercises,
    String? mustInclude,
  }) {
    return MobileBookRecipe(
      lane: lane ?? this.lane,
      title: title ?? this.title,
      artifact: artifact ?? this.artifact,
      audience: audience ?? this.audience,
      promise: promise ?? this.promise,
      tone: tone ?? this.tone,
      mainCharacter: mainCharacter ?? this.mainCharacter,
      conflict: conflict ?? this.conflict,
      ending: ending ?? this.ending,
      theme: theme ?? this.theme,
      nextStep: nextStep ?? this.nextStep,
      exercises: exercises ?? this.exercises,
      mustInclude: mustInclude ?? this.mustInclude,
    );
  }
}

class MobileCreationPresets {
  const MobileCreationPresets({
    required this.bookType,
    this.bookTypeChoice = 'auto',
    required this.lengthPreset,
    required this.qualityPreset,
    required this.imagesEnabled,
    this.pageCountMode = 'auto',
    this.targetPages,
    this.pageCountSource,
  });

  final String bookType;
  final String bookTypeChoice;
  final String lengthPreset;
  final String qualityPreset;
  final bool imagesEnabled;
  final String pageCountMode;
  final int? targetPages;
  final String? pageCountSource;

  factory MobileCreationPresets.fromJson(Map<String, dynamic> json) {
    return MobileCreationPresets(
      bookType: json['bookType'] as String,
      bookTypeChoice: json['bookTypeChoice'] as String? ?? 'auto',
      lengthPreset: json['lengthPreset'] as String,
      qualityPreset: json['qualityPreset'] as String,
      imagesEnabled: json['imagesEnabled'] as bool,
      pageCountMode: json['pageCountMode'] as String? ?? 'auto',
      targetPages: json['targetPages'] as int?,
      pageCountSource: json['pageCountSource'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'bookType': bookType,
      'bookTypeChoice': bookTypeChoice,
      'lengthPreset': lengthPreset,
      'qualityPreset': qualityPreset,
      'imagesEnabled': imagesEnabled,
      'pageCountMode': pageCountMode,
      if (targetPages != null) 'targetPages': targetPages,
      if (pageCountSource != null) 'pageCountSource': pageCountSource,
    };
  }

  MobileCreationPresets copyWith({
    String? bookType,
    String? bookTypeChoice,
    String? lengthPreset,
    String? qualityPreset,
    bool? imagesEnabled,
    String? pageCountMode,
    Object? targetPages = _sentinel,
    Object? pageCountSource = _sentinel,
  }) {
    return MobileCreationPresets(
      bookType: bookType ?? this.bookType,
      bookTypeChoice: bookTypeChoice ?? this.bookTypeChoice,
      lengthPreset: lengthPreset ?? this.lengthPreset,
      qualityPreset: qualityPreset ?? this.qualityPreset,
      imagesEnabled: imagesEnabled ?? this.imagesEnabled,
      pageCountMode: pageCountMode ?? this.pageCountMode,
      targetPages: targetPages == _sentinel
          ? this.targetPages
          : targetPages as int?,
      pageCountSource: pageCountSource == _sentinel
          ? this.pageCountSource
          : pageCountSource as String?,
    );
  }

  static const _sentinel = Object();
}

class MobileCreationDraftPayload {
  const MobileCreationDraftPayload({
    this.payloadVersion = 2,
    this.rawIdea = '',
    this.optionalDetails = const MobileCreationOptionalDetails(),
    this.sourceNotes = '',
    this.detectedLane,
    this.recipe,
    this.selectedPresets,
  });

  final int payloadVersion;
  final String rawIdea;
  final MobileCreationOptionalDetails optionalDetails;
  final String sourceNotes;
  final String? detectedLane;
  final MobileBookRecipe? recipe;
  final MobileCreationPresets? selectedPresets;

  factory MobileCreationDraftPayload.fromJson(Map<String, dynamic> json) {
    final legacyBrief = json['brief'];
    final optionalDetails = json['optionalDetails'];
    final recipe = json['recipe'];
    final selectedPresets = json['selectedPresets'];
    if (legacyBrief is Map<String, dynamic> &&
        (json['rawIdea'] as String? ?? '').trim().isEmpty) {
      return MobileCreationDraftPayload(
        rawIdea: legacyBrief['topic'] as String? ?? '',
        optionalDetails: MobileCreationOptionalDetails(
          title: legacyBrief['title'] as String? ?? '',
          authorName: legacyBrief['authorName'] as String? ?? '',
          mustInclude: legacyBrief['mustInclude'] as String? ?? '',
          tone: legacyBrief['tone'] as String? ?? '',
        ),
        sourceNotes: legacyBrief['sourceNotes'] as String? ?? '',
        detectedLane: _laneFromLegacyIntent(
          legacyBrief['intent'] as String? ?? 'collect_leads',
        ),
        recipe: recipe == null
            ? null
            : MobileBookRecipe.fromJson(recipe as Map<String, dynamic>),
        selectedPresets: selectedPresets == null
            ? null
            : MobileCreationPresets.fromJson(
                selectedPresets as Map<String, dynamic>,
              ),
      );
    }
    return MobileCreationDraftPayload(
      payloadVersion: json['payloadVersion'] as int? ?? 2,
      rawIdea: json['rawIdea'] as String? ?? '',
      optionalDetails: optionalDetails == null
          ? const MobileCreationOptionalDetails()
          : MobileCreationOptionalDetails.fromJson(
              optionalDetails as Map<String, dynamic>,
            ),
      sourceNotes: json['sourceNotes'] as String? ?? '',
      detectedLane: json['detectedLane'] as String?,
      recipe: recipe == null
          ? null
          : MobileBookRecipe.fromJson(recipe as Map<String, dynamic>),
      selectedPresets: selectedPresets == null
          ? null
          : MobileCreationPresets.fromJson(
              selectedPresets as Map<String, dynamic>,
            ),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'payloadVersion': 2,
      'rawIdea': rawIdea.trim(),
      'optionalDetails': optionalDetails.toJson(),
      'sourceNotes': sourceNotes.trim(),
      if (detectedLane != null) 'detectedLane': detectedLane,
      if (recipe != null) 'recipe': recipe!.toJson(),
      if (selectedPresets != null) 'selectedPresets': selectedPresets!.toJson(),
    };
  }

  bool get hasMeaningfulContent {
    return rawIdea.trim().isNotEmpty ||
        sourceNotes.trim().isNotEmpty ||
        optionalDetails.hasContent ||
        recipe != null;
  }
}

class MobileBookAdvisorResponse {
  const MobileBookAdvisorResponse({
    required this.recommendation,
    required this.detectedLane,
    required this.recipe,
    required this.briefScore,
    required this.missingFields,
    required this.warnings,
    required this.followUpSuggestions,
    required this.bookShapePreview,
    required this.titleSuggestions,
    required this.rationale,
  });

  final MobileCreationPresets recommendation;
  final String detectedLane;
  final MobileBookRecipe recipe;
  final int briefScore;
  final List<String> missingFields;
  final List<String> warnings;
  final List<String> followUpSuggestions;
  final List<String> bookShapePreview;
  final List<String> titleSuggestions;
  final String rationale;

  factory MobileBookAdvisorResponse.fromJson(Map<String, dynamic> json) {
    final recommendation = MobileCreationPresets.fromJson(
      json['recommendation'] as Map<String, dynamic>,
    );
    final recipe = json['recipe'];
    final detectedLane =
        json['detectedLane'] as String? ??
        (recipe is Map<String, dynamic>
            ? recipe['lane'] as String? ??
                  _laneFromBookType(recommendation.bookType)
            : _laneFromBookType(recommendation.bookType));
    return MobileBookAdvisorResponse(
      recommendation: recommendation,
      detectedLane: detectedLane,
      recipe: recipe is Map<String, dynamic>
          ? MobileBookRecipe.fromJson(recipe)
          : MobileBookRecipe(lane: detectedLane),
      briefScore: json['briefScore'] as int,
      missingFields: _stringList(json['missingFields']),
      warnings: _stringList(json['warnings']),
      followUpSuggestions: _stringList(json['followUpSuggestions']),
      bookShapePreview: _stringList(json['bookShapePreview']),
      titleSuggestions: _stringList(json['titleSuggestions']),
      rationale: json['rationale'] as String? ?? '',
    );
  }
}

class MobileCreationDraft {
  const MobileCreationDraft({
    required this.id,
    required this.status,
    required this.payload,
    required this.createdAt,
    required this.updatedAt,
    this.advisorSnapshot,
    this.createdProjectId,
  });

  final String id;
  final String status;
  final MobileCreationDraftPayload payload;
  final MobileBookAdvisorResponse? advisorSnapshot;
  final String? createdProjectId;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory MobileCreationDraft.fromJson(Map<String, dynamic> json) {
    final advisor = json['advisorSnapshot'];
    return MobileCreationDraft(
      id: json['id'] as String,
      status: json['status'] as String,
      payload: MobileCreationDraftPayload.fromJson(
        json['payload'] as Map<String, dynamic>,
      ),
      advisorSnapshot: advisor == null
          ? null
          : MobileBookAdvisorResponse.fromJson(advisor as Map<String, dynamic>),
      createdProjectId: json['createdProjectId'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}

class MobileCreationMessage {
  const MobileCreationMessage({
    required this.role,
    required this.content,
    this.attachments = const [],
  });

  final String role;
  final String content;
  final List<MobileCreationMessageAttachment> attachments;

  bool get isUser => role == 'user';

  bool get hasAttachments => attachments.isNotEmpty;

  factory MobileCreationMessage.fromJson(Map<String, dynamic> json) {
    final attachments = json['attachments'] as List<dynamic>? ?? const [];
    return MobileCreationMessage(
      role: json['role'] as String,
      content: json['content'] as String,
      attachments: attachments
          .map(
            (attachment) => MobileCreationMessageAttachment.fromJson(
              attachment as Map<String, dynamic>,
            ),
          )
          .toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'role': role,
      'content': content,
      if (attachments.isNotEmpty)
        'attachments': attachments
            .map((attachment) => attachment.toJson())
            .toList(),
    };
  }
}

/// Reference from a chat message to a file uploaded into the conversation.
class MobileCreationMessageAttachment {
  const MobileCreationMessageAttachment({
    required this.id,
    required this.kind,
    required this.name,
  });

  final String id;
  final String kind;
  final String name;

  bool get isPhoto => kind == 'photo';

  factory MobileCreationMessageAttachment.fromJson(Map<String, dynamic> json) {
    return MobileCreationMessageAttachment(
      id: json['id'] as String,
      kind: json['kind'] as String? ?? 'document',
      name: json['name'] as String? ?? 'attachment',
    );
  }

  Map<String, dynamic> toJson() {
    return {'id': id, 'kind': kind, 'name': name};
  }
}

/// A file uploaded into the creation chat, already read by the server.
class MobileCreationAttachment {
  const MobileCreationAttachment({
    required this.id,
    required this.kind,
    required this.name,
    required this.sizeBytes,
    this.summary = '',
    this.pages,
    this.truncated = false,
    this.url,
  });

  final String id;
  final String kind;
  final String name;
  final int sizeBytes;
  final String summary;
  final int? pages;
  final bool truncated;

  /// API path serving the stored original file; null for uploads made before
  /// server-side storage existed or after the retention window.
  final String? url;

  bool get isPhoto => kind == 'photo';

  factory MobileCreationAttachment.fromJson(Map<String, dynamic> json) {
    return MobileCreationAttachment(
      id: json['id'] as String,
      kind: json['kind'] as String? ?? 'document',
      name: json['name'] as String? ?? 'attachment',
      sizeBytes: json['sizeBytes'] as int? ?? 0,
      summary: json['summary'] as String? ?? '',
      pages: json['pages'] as int?,
      truncated: json['truncated'] as bool? ?? false,
      url: json['url'] as String?,
    );
  }
}

class MobileCreationQuestion {
  const MobileCreationQuestion({
    required this.prompt,
    required this.options,
    required this.allowCustom,
  });

  final String prompt;
  final List<String> options;
  final bool allowCustom;

  factory MobileCreationQuestion.fromJson(Map<String, dynamic> json) {
    return MobileCreationQuestion(
      prompt: json['prompt'] as String,
      options: _stringList(json['options']),
      allowCustom: json['allowCustom'] as bool? ?? true,
    );
  }
}

class MobileCreationReadiness {
  const MobileCreationReadiness({
    required this.score,
    required this.canBuild,
    required this.missing,
  });

  final int score;
  final bool canBuild;
  final List<String> missing;

  factory MobileCreationReadiness.fromJson(Map<String, dynamic> json) {
    return MobileCreationReadiness(
      score: json['score'] as int? ?? 0,
      canBuild: json['canBuild'] as bool? ?? false,
      missing: _stringList(json['missing']),
    );
  }
}

class MobileCreationTurn {
  const MobileCreationTurn({
    required this.assistantMessage,
    required this.brief,
    required this.presets,
    required this.detectedLane,
    required this.quickReplies,
    required this.readiness,
    required this.titleSuggestions,
    required this.shapePreview,
    required this.warnings,
    this.question,
    this.language,
    this.buildRequested = false,
  });

  final String assistantMessage;
  final MobileBookRecipe brief;
  final MobileCreationPresets presets;
  final String detectedLane;
  final List<String> quickReplies;
  final MobileCreationQuestion? question;
  final MobileCreationReadiness readiness;
  final List<String> titleSuggestions;
  final List<String> shapePreview;
  final List<String> warnings;

  /// Book language detected from the chat ("fa", "es", ...), if any.
  final String? language;

  /// True when the user asked in chat to build the plan ("ok build it").
  final bool buildRequested;

  factory MobileCreationTurn.fromJson(Map<String, dynamic> json) {
    final question = json['question'];
    return MobileCreationTurn(
      assistantMessage: json['assistantMessage'] as String? ?? '',
      brief: MobileBookRecipe.fromJson(json['brief'] as Map<String, dynamic>),
      presets: MobileCreationPresets.fromJson(
        json['presets'] as Map<String, dynamic>,
      ),
      detectedLane: json['detectedLane'] as String? ?? 'auto',
      quickReplies: _stringList(json['quickReplies']),
      question: question is Map<String, dynamic>
          ? MobileCreationQuestion.fromJson(question)
          : null,
      readiness: MobileCreationReadiness.fromJson(
        json['readiness'] as Map<String, dynamic>,
      ),
      titleSuggestions: _stringList(json['titleSuggestions']),
      shapePreview: _stringList(json['shapePreview']),
      warnings: _stringList(json['warnings']),
      language: json['language'] as String?,
      buildRequested: json['buildRequested'] as bool? ?? false,
    );
  }
}

class MobileCreationSession {
  const MobileCreationSession({
    required this.draftId,
    required this.title,
    required this.status,
    required this.messages,
    required this.updatedAt,
    this.outputs = const [],
    this.attachments = const [],
    this.createdProjectId,
    this.activeProjectId,
  });

  final String draftId;
  final String title;
  final String status;
  final List<MobileCreationMessage> messages;
  final String? createdProjectId;
  final String? activeProjectId;
  final List<MobileCreationOutput> outputs;

  /// Every file uploaded into this chat (sent or still pending in composer).
  final List<MobileCreationAttachment> attachments;
  final DateTime updatedAt;

  factory MobileCreationSession.fromJson(Map<String, dynamic> json) {
    final messages = json['messages'] as List<dynamic>? ?? const [];
    final outputs = json['outputs'] as List<dynamic>? ?? const [];
    final attachments = json['attachments'] as List<dynamic>? ?? const [];
    return MobileCreationSession(
      draftId: json['draftId'] as String,
      title: json['title'] as String? ?? 'New book',
      status: json['status'] as String,
      messages: messages
          .map(
            (message) =>
                MobileCreationMessage.fromJson(message as Map<String, dynamic>),
          )
          .toList(),
      createdProjectId: json['createdProjectId'] as String?,
      activeProjectId:
          json['activeProjectId'] as String? ??
          json['createdProjectId'] as String?,
      outputs: outputs
          .map(
            (output) =>
                MobileCreationOutput.fromJson(output as Map<String, dynamic>),
          )
          .toList(),
      attachments: attachments
          .map(
            (attachment) => MobileCreationAttachment.fromJson(
              attachment as Map<String, dynamic>,
            ),
          )
          .toList(),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}

class MobileCreationOutput {
  const MobileCreationOutput({
    required this.id,
    required this.draftId,
    required this.projectId,
    required this.title,
    required this.sequence,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String draftId;
  final String projectId;
  final String title;
  final int sequence;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory MobileCreationOutput.fromJson(Map<String, dynamic> json) {
    return MobileCreationOutput(
      id: json['id'] as String,
      draftId: json['draftId'] as String,
      projectId: json['projectId'] as String,
      title: json['title'] as String? ?? 'Book output',
      sequence: json['sequence'] as int? ?? 1,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}

class MobileCreationConversationResponse {
  const MobileCreationConversationResponse({required this.turn, this.session});

  final MobileCreationSession? session;
  final MobileCreationTurn turn;

  factory MobileCreationConversationResponse.fromJson(
    Map<String, dynamic> json,
  ) {
    final session = json['session'];
    return MobileCreationConversationResponse(
      session: session == null
          ? null
          : MobileCreationSession.fromJson(session as Map<String, dynamic>),
      turn: MobileCreationTurn.fromJson(json['turn'] as Map<String, dynamic>),
    );
  }
}

class MobilePageCountRecommendation {
  const MobilePageCountRecommendation({
    required this.targetPages,
    required this.label,
    required this.description,
  });

  final int targetPages;
  final String label;
  final String description;

  factory MobilePageCountRecommendation.fromJson(Map<String, dynamic> json) {
    return MobilePageCountRecommendation(
      targetPages: json['targetPages'] as int,
      label: json['label'] as String? ?? '${json['targetPages']} pages',
      description: json['description'] as String? ?? '',
    );
  }
}

class MobileDetectedPageCount {
  const MobileDetectedPageCount({
    required this.targetPages,
    required this.source,
  });

  final int targetPages;
  final String source;

  factory MobileDetectedPageCount.fromJson(Map<String, dynamic> json) {
    return MobileDetectedPageCount(
      targetPages: json['targetPages'] as int,
      source: json['source'] as String? ?? 'chat',
    );
  }
}

class MobileCreationBuildPreflight {
  const MobileCreationBuildPreflight({
    required this.requiresPageCount,
    required this.recommendations,
    this.detectedPageCount,
  });

  final bool requiresPageCount;
  final MobileDetectedPageCount? detectedPageCount;
  final List<MobilePageCountRecommendation> recommendations;

  factory MobileCreationBuildPreflight.fromJson(Map<String, dynamic> json) {
    final detected = json['detectedPageCount'];
    final recommendations = json['recommendations'] as List<dynamic>? ?? const [];
    return MobileCreationBuildPreflight(
      requiresPageCount: json['requiresPageCount'] as bool? ?? false,
      detectedPageCount: detected == null
          ? null
          : MobileDetectedPageCount.fromJson(detected as Map<String, dynamic>),
      recommendations: recommendations
          .map(
            (item) => MobilePageCountRecommendation.fromJson(
              item as Map<String, dynamic>,
            ),
          )
          .toList(),
    );
  }
}

class MobileCreationFinalizeResponse {
  const MobileCreationFinalizeResponse({
    required this.project,
    this.output,
    this.operation,
  });

  final MobileProjectDetail project;
  final MobileCreationOutput? output;
  final MobilePlanOperation? operation;

  factory MobileCreationFinalizeResponse.fromJson(Map<String, dynamic> json) {
    final operation = json['operation'];
    final output = json['output'];
    return MobileCreationFinalizeResponse(
      project: MobileProjectDetail.fromJson(
        json['project'] as Map<String, dynamic>,
      ),
      output: output == null
          ? null
          : MobileCreationOutput.fromJson(output as Map<String, dynamic>),
      operation: operation == null
          ? null
          : MobilePlanOperation.fromJson(operation as Map<String, dynamic>),
    );
  }
}

class MobileChatSession {
  const MobileChatSession({
    required this.draftId,
    required this.title,
    required this.preview,
    required this.messageCount,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.outputs = const [],
    this.createdProjectId,
    this.activeProjectId,
  });

  final String draftId;
  final String title;
  final String preview;
  final int messageCount;
  final String status;
  final String? createdProjectId;
  final String? activeProjectId;
  final List<MobileCreationOutput> outputs;
  final DateTime createdAt;
  final DateTime updatedAt;

  bool get isActive => status == 'ACTIVE';

  factory MobileChatSession.fromJson(Map<String, dynamic> json) {
    final outputs = json['outputs'] as List<dynamic>? ?? const [];
    return MobileChatSession(
      draftId: json['draftId'] as String,
      title: json['title'] as String,
      preview: json['preview'] as String,
      messageCount: json['messageCount'] as int,
      status: json['status'] as String,
      createdProjectId: json['createdProjectId'] as String?,
      activeProjectId:
          json['activeProjectId'] as String? ??
          json['createdProjectId'] as String?,
      outputs: outputs
          .map(
            (output) =>
                MobileCreationOutput.fromJson(output as Map<String, dynamic>),
          )
          .toList(),
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}

List<String> _stringList(Object? value) {
  if (value is! List<dynamic>) {
    return const [];
  }
  return value.whereType<String>().toList(growable: false);
}

String _laneFromBookType(String bookType) {
  return switch (bookType) {
    'workbook' => 'workbook',
    'short_story' => 'adult_story',
    _ => 'lead_magnet',
  };
}

String _laneFromLegacyIntent(String intent) {
  return switch (intent) {
    'teach_practice' => 'workbook',
    'support_clients' => 'client_tool',
    'explain_offer' => 'offer_guide',
    'short_story' => 'adult_story',
    _ => 'lead_magnet',
  };
}

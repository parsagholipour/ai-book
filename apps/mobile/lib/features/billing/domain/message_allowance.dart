class MessageAllowance {
  const MessageAllowance({
    required this.used,
    required this.limit,
    required this.remaining,
    required this.creditsPerMessage,
    required this.resetEnabled,
    required this.resetCredits,
    required this.resetsAt,
    required this.resetToken,
  });

  final int used;
  final int limit;
  final int remaining;
  final int creditsPerMessage;
  final bool resetEnabled;
  final int resetCredits;
  final DateTime resetsAt;
  final String resetToken;

  bool get isExhausted => remaining <= 0;

  factory MessageAllowance.fromJson(Map<String, dynamic> json) =>
      MessageAllowance(
        used: (json['used'] as num).toInt(),
        limit: (json['limit'] as num).toInt(),
        remaining: (json['remaining'] as num).toInt(),
        creditsPerMessage: (json['creditsPerMessage'] as num).toInt(),
        resetEnabled: json['resetEnabled'] == true,
        resetCredits: (json['resetCredits'] as num).toInt(),
        resetsAt: DateTime.parse(json['resetsAt'] as String),
        resetToken: json['resetToken'] as String,
      );
}

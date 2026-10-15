// The credit history: one page of ledger lines, as the account's Credits
// screen reads them. Split out of `billing_models.dart`, which re-exports it.

/// What a credit log entry was, in the reader's terms. The server sends the
/// name; anything it adds later that this list has not caught up with reads as
/// [CreditLogKind.spend] or [CreditLogKind.bonus] depending on its direction.
enum CreditLogKind {
  purchase,
  subscription,
  monthly,
  bonus,
  spend,
  refund,
  expired,
}

/// One movement of credits: bought, granted, charged, or given back.
///
/// [credits] is always positive — [addsCredits] carries the sign. A [refunded]
/// entry is history rather than a movement: the credits came straight back, so
/// the balance never kept the change.
class CreditLogEntry {
  const CreditLogEntry({
    required this.id,
    required this.createdAt,
    required this.addsCredits,
    required this.credits,
    required this.kind,
    required this.title,
    this.pending = false,
    this.refunded = false,
    this.projectId,
    this.projectTitle,
  });

  final String id;
  final DateTime createdAt;
  final bool addsCredits;
  final int credits;
  final CreditLogKind kind;
  final String title;

  /// Held against work still running. The credits are gone from the balance,
  /// but the charge is not settled and may still come back.
  final bool pending;
  final bool refunded;
  final String? projectId;
  final String? projectTitle;

  factory CreditLogEntry.fromJson(Map<String, dynamic> json) {
    final addsCredits = (json['direction'] as String?) != 'out';
    return CreditLogEntry(
      id: json['id'] as String,
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.now(),
      addsCredits: addsCredits,
      credits: json['credits'] as int? ?? 0,
      kind: _creditLogKind(json['kind'] as String?, addsCredits: addsCredits),
      title: json['title'] as String? ?? 'Credits',
      pending: json['pending'] as bool? ?? false,
      refunded: json['refunded'] as bool? ?? false,
      projectId: json['projectId'] as String?,
      projectTitle: json['projectTitle'] as String?,
    );
  }
}

CreditLogKind _creditLogKind(String? value, {required bool addsCredits}) {
  return switch (value) {
    'purchase' => CreditLogKind.purchase,
    'subscription' => CreditLogKind.subscription,
    'monthly' => CreditLogKind.monthly,
    'bonus' => CreditLogKind.bonus,
    'spend' => CreditLogKind.spend,
    'refund' => CreditLogKind.refund,
    'expired' => CreditLogKind.expired,
    _ => addsCredits ? CreditLogKind.bonus : CreditLogKind.spend,
  };
}

/// A page of credit history. [nextCursor] is null once the history has run out,
/// which is what stops the list asking for more.
class CreditLogPage {
  const CreditLogPage({required this.entries, this.nextCursor});

  final List<CreditLogEntry> entries;
  final String? nextCursor;

  factory CreditLogPage.fromJson(Map<String, dynamic> json) {
    final entries = json['entries'] as List<dynamic>? ?? const [];
    return CreditLogPage(
      entries: entries
          .map((item) => CreditLogEntry.fromJson(item as Map<String, dynamic>))
          .toList(),
      nextCursor: json['nextCursor'] as String?,
    );
  }
}

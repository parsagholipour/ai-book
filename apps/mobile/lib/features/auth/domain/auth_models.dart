class AuthUser {
  const AuthUser({
    required this.id,
    required this.email,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.displayName,
    this.legalAcceptanceRequired = false,
    this.emailVerified = true,
  });

  final String id;
  final String email;
  final String? displayName;
  final String status;
  final DateTime createdAt;
  final DateTime updatedAt;
  final bool legalAcceptanceRequired;

  /// Whether the account has proven it receives mail at [email]: a confirmed
  /// code or a Google sign-in. The welcome credits wait for it. A server that
  /// predates verification never sends it and has nothing to wait for, so
  /// absent reads as verified.
  final bool emailVerified;

  factory AuthUser.fromJson(Map<String, dynamic> json) {
    return AuthUser(
      id: json['id'] as String,
      email: json['email'] as String,
      displayName: json['displayName'] as String?,
      status: json['status'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
      legalAcceptanceRequired:
          json['legalAcceptanceRequired'] as bool? ?? false,
      emailVerified: json['emailVerified'] as bool? ?? true,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'email': email,
      'displayName': displayName,
      'status': status,
      'createdAt': createdAt.toUtc().toIso8601String(),
      'updatedAt': updatedAt.toUtc().toIso8601String(),
      'legalAcceptanceRequired': legalAcceptanceRequired,
      'emailVerified': emailVerified,
    };
  }

  String get displayLabel {
    final name = displayName?.trim();
    return name == null || name.isEmpty ? email : name;
  }

  String get initials {
    final name = displayName?.trim();
    if (name != null && name.isNotEmpty) {
      final parts = name
          .split(RegExp(r'\s+'))
          .where((part) => part.isNotEmpty)
          .toList();
      if (parts.length >= 2) {
        return '${parts[0][0]}${parts[1][0]}'.toUpperCase();
      }
      return name[0].toUpperCase();
    }
    final trimmedEmail = email.trim();
    return trimmedEmail.isEmpty ? '?' : trimmedEmail[0].toUpperCase();
  }

  AuthUser copyWith({bool? legalAcceptanceRequired, bool? emailVerified}) {
    return AuthUser(
      id: id,
      email: email,
      displayName: displayName,
      status: status,
      createdAt: createdAt,
      updatedAt: updatedAt,
      legalAcceptanceRequired:
          legalAcceptanceRequired ?? this.legalAcceptanceRequired,
      emailVerified: emailVerified ?? this.emailVerified,
    );
  }
}

class MobileSessionTokens {
  const MobileSessionTokens({
    required this.accessToken,
    required this.accessTokenExpiresAt,
    required this.refreshToken,
    required this.refreshTokenExpiresAt,
    this.deviceClockAhead = Duration.zero,
  });

  final String accessToken;

  /// Both expiries are the server's clock, as the server sent them.
  final DateTime accessTokenExpiresAt;
  final String refreshToken;
  final DateTime refreshTokenExpiresAt;

  /// How far this device's clock ran ahead of the server's when the tokens
  /// were issued (negative when it runs behind). Every test of an expiry takes
  /// it off `DateTime.now()` first, so the answer is the server's.
  ///
  /// Without it a phone fifteen minutes fast saw every new access token as
  /// already due: each request refreshed before it was sent, and the image
  /// headers re-read themselves once a second, rotating the token each time.
  final Duration deviceClockAhead;

  /// [requestedAt] is when the device asked for these tokens. Pass it for a
  /// server response, never for a stored copy: with it, the response's
  /// `accessTokenExpiresIn` measures the clock offset.
  factory MobileSessionTokens.fromJson(
    Map<String, dynamic> json, {
    DateTime? requestedAt,
  }) {
    final accessTokenExpiresAt = DateTime.parse(
      json['accessTokenExpiresAt'] as String,
    );
    return MobileSessionTokens(
      accessToken: json['accessToken'] as String,
      accessTokenExpiresAt: accessTokenExpiresAt,
      refreshToken: json['refreshToken'] as String,
      refreshTokenExpiresAt: DateTime.parse(
        json['refreshTokenExpiresAt'] as String,
      ),
      deviceClockAhead: _deviceClockAhead(
        json,
        accessTokenExpiresAt,
        requestedAt,
      ),
    );
  }

  static Duration _deviceClockAhead(
    Map<String, dynamic> json,
    DateTime accessTokenExpiresAt,
    DateTime? requestedAt,
  ) {
    // A server response says how long the token has left, which gives the
    // server's clock at issue. Counting from the request rather than the
    // response errs early, by the round trip, never late.
    final expiresIn = json['accessTokenExpiresIn'];
    if (requestedAt != null && expiresIn is num && expiresIn >= 0) {
      final issuedAt = accessTokenExpiresAt.subtract(
        Duration(milliseconds: (expiresIn * 1000).round()),
      );
      return requestedAt.toUtc().difference(issuedAt.toUtc());
    }
    final stored = json['deviceClockAheadMs'];
    if (stored is num) return Duration(milliseconds: stored.round());
    // Stored by an older build, or sent by a server that does not say the
    // lifetime: trust the device clock, as every build before this one did.
    return Duration.zero;
  }

  /// The stored form. Builds already installed read only the four fields they
  /// know, so `deviceClockAheadMs` is an addition, never a replacement.
  Map<String, dynamic> toJson() {
    return {
      'accessToken': accessToken,
      'accessTokenExpiresAt': accessTokenExpiresAt.toUtc().toIso8601String(),
      'refreshToken': refreshToken,
      'refreshTokenExpiresAt': refreshTokenExpiresAt.toUtc().toIso8601String(),
      'deviceClockAheadMs': deviceClockAhead.inMilliseconds,
    };
  }

  /// The server's clock, read off this device's.
  DateTime _serverNow() => DateTime.now().toUtc().subtract(deviceClockAhead);

  bool get isRefreshExpired {
    return refreshTokenExpiresAt.isBefore(_serverNow());
  }

  /// The moment the access token stops being worth sending: from here on the
  /// client refreshes it before using it.
  DateTime get accessTokenRefreshAt =>
      accessTokenExpiresAt.subtract(const Duration(seconds: 45));

  /// How long until [accessTokenRefreshAt], on this device's clock. Negative
  /// once it has passed.
  Duration get refreshDueIn => accessTokenRefreshAt.difference(_serverNow());

  bool get shouldRefreshAccessToken => refreshDueIn.isNegative;
}

class AuthSession {
  const AuthSession({
    required this.user,
    required this.tokens,
    this.offline = false,
  });

  final AuthUser user;
  final MobileSessionTokens tokens;

  /// Restored from this phone alone because the server could not be reached:
  /// [user] is the copy kept from the last time it could, and nothing has
  /// confirmed the session is still alive. `AuthController` keeps asking, and
  /// either replaces this with a confirmed session or signs the reader out.
  final bool offline;

  /// A server response; [requestedAt] as in [MobileSessionTokens.fromJson].
  factory AuthSession.fromJson(
    Map<String, dynamic> json, {
    DateTime? requestedAt,
  }) {
    return AuthSession(
      user: AuthUser.fromJson(json['user'] as Map<String, dynamic>),
      tokens: MobileSessionTokens.fromJson(
        json['session'] as Map<String, dynamic>,
        requestedAt: requestedAt,
      ),
    );
  }
}

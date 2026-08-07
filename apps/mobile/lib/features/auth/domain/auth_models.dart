class AuthUser {
  const AuthUser({
    required this.id,
    required this.email,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.displayName,
    this.legalAcceptanceRequired = false,
  });

  final String id;
  final String email;
  final String? displayName;
  final String status;
  final DateTime createdAt;
  final DateTime updatedAt;
  final bool legalAcceptanceRequired;

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
    };
  }

  String get displayLabel {
    final name = displayName?.trim();
    return name == null || name.isEmpty ? email : name;
  }

  AuthUser copyWith({bool? legalAcceptanceRequired}) {
    return AuthUser(
      id: id,
      email: email,
      displayName: displayName,
      status: status,
      createdAt: createdAt,
      updatedAt: updatedAt,
      legalAcceptanceRequired:
          legalAcceptanceRequired ?? this.legalAcceptanceRequired,
    );
  }
}

class MobileSessionTokens {
  const MobileSessionTokens({
    required this.accessToken,
    required this.accessTokenExpiresAt,
    required this.refreshToken,
    required this.refreshTokenExpiresAt,
  });

  final String accessToken;
  final DateTime accessTokenExpiresAt;
  final String refreshToken;
  final DateTime refreshTokenExpiresAt;

  factory MobileSessionTokens.fromJson(Map<String, dynamic> json) {
    return MobileSessionTokens(
      accessToken: json['accessToken'] as String,
      accessTokenExpiresAt: DateTime.parse(
        json['accessTokenExpiresAt'] as String,
      ),
      refreshToken: json['refreshToken'] as String,
      refreshTokenExpiresAt: DateTime.parse(
        json['refreshTokenExpiresAt'] as String,
      ),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'accessToken': accessToken,
      'accessTokenExpiresAt': accessTokenExpiresAt.toUtc().toIso8601String(),
      'refreshToken': refreshToken,
      'refreshTokenExpiresAt': refreshTokenExpiresAt.toUtc().toIso8601String(),
    };
  }

  bool get isRefreshExpired {
    return refreshTokenExpiresAt.isBefore(DateTime.now().toUtc());
  }

  bool get shouldRefreshAccessToken {
    return accessTokenExpiresAt.isBefore(
      DateTime.now().toUtc().add(const Duration(seconds: 45)),
    );
  }
}

class AuthSession {
  const AuthSession({required this.user, required this.tokens});

  final AuthUser user;
  final MobileSessionTokens tokens;

  factory AuthSession.fromJson(Map<String, dynamic> json) {
    return AuthSession(
      user: AuthUser.fromJson(json['user'] as Map<String, dynamic>),
      tokens: MobileSessionTokens.fromJson(
        json['session'] as Map<String, dynamic>,
      ),
    );
  }
}

const currentTermsVersion = '2026-08-08';
const currentPrivacyVersion = '2026-08-08';

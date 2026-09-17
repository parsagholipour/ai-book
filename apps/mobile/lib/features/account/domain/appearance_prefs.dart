/// How the app chooses its light or dark theme.
enum AppearanceMode {
  system,
  light,
  dark;

  String get label => switch (this) {
    AppearanceMode.system => 'System',
    AppearanceMode.light => 'Light',
    AppearanceMode.dark => 'Dark',
  };

  static AppearanceMode parse(String? value) {
    return AppearanceMode.values.asNameMap()[value] ?? AppearanceMode.system;
  }

  factory AppearanceMode.fromJson(Map<String, dynamic> json) {
    return AppearanceMode.parse(json['mode'] as String?);
  }

  Map<String, dynamic> toJson() => {'mode': name};
}

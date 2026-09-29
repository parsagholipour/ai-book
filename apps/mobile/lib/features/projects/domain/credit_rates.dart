/// The two primitives every credit quote in the app is built from. Moved out
/// of `project_models.dart` so the Writing Studio's quotes read the same rates
/// the book quote does; see that file for the formulas that mirror the server.
library;

/// One rate at the tier this book is priced at.
///
/// Mirrors `tierPrice` in `packages/core/src/billing.ts`, including its key
/// convention: the unsuffixed key is the balanced rate and the others add
/// `Fast` / `Premium` / `Ultra`. Anything that is not one of the four tier
/// names — the server sends `'custom'` for a book it has no preset for — is
/// balanced, which is exactly what the server charges such a book.
///
/// The fallbacks are only reached before `/api/mobile/billing` has loaded; they
/// duplicate `DEFAULT_CREDIT_COSTS`, so the two must move together.
int tierCreditRate(
  Map<String, dynamic> creditCosts,
  String baseKey,
  String qualityPreset,
  Map<String, int> fallbacks,
) {
  final tier = switch (qualityPreset) {
    'fast' || 'premium' || 'ultra' => qualityPreset,
    _ => 'balanced',
  };
  final key = switch (tier) {
    'fast' => '${baseKey}Fast',
    'premium' => '${baseKey}Premium',
    'ultra' => '${baseKey}Ultra',
    _ => baseKey,
  };
  return flatCreditRate(
    creditCosts,
    key,
    fallbacks[tier] ?? fallbacks['balanced'] ?? 0,
  );
}

/// A flat rate, or [fallback] before `/api/mobile/billing` has loaded.
int flatCreditRate(Map<String, dynamic> creditCosts, String key, int fallback) {
  final value = creditCosts[key];
  if (value is int) {
    return value;
  }
  if (value is num) {
    return value.round();
  }
  return fallback;
}

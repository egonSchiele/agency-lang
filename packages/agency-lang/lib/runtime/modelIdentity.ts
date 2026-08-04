// The billing aggregation key for a completion.
//
// Extracted from the prompt completion site so the precedence is one testable
// rule rather than an inline expression: the provider-reported model wins, then
// the requested/configured model, then a literal fallback. The string is used
// verbatim as the per-model breakdown key (no provider-name normalization), so a
// real model that happens to be named "unknown model" is an ordinary model.

export function resolveCompletionModel(
  completionModel: string | null | undefined,
  configuredModel: string | null | undefined,
): string {
  return completionModel || configuredModel || "unknown model";
}

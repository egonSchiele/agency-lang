import { mergeFields } from "./localDefaults.js";

/**
 * The round warning: a user message the tool loop sends the model when
 * few tool rounds are left in an `llm()` call, set with the
 * `warnAtRoundsLeft` option. The message expires with the call. See "The
 * round warning" in docs/dev/agents/tool-loop-guards.md.
 */

/** The `warnAtRoundsLeft` option, on `llm()` and in `setLlmOptions`. */
export type WarnAtRoundsLeft = {
  /** The first warning goes out when this many rounds are left. 0 turns it off. */
  remaining?: number;
  /** The first warning's text; `{remaining}` and `{limit}` are filled in. */
  text?: string;
  /** Whether to warn when one round is left. */
  finalWarning?: boolean;
  /** The final warning's text, with the same placeholders. */
  finalWarningText?: string;
};

export type RoundWarningSettings = Required<WarnAtRoundsLeft>;

export const DEFAULT_ROUND_WARNING: RoundWarningSettings = {
  remaining: 3,
  text: "Of the {limit} tool rounds for this request, {remaining} remain. Finish what you can with them and then write your answer.",
  finalWarning: true,
  finalWarningText:
    "This is the last tool round for this request. The results of the tool calls you make now are the last you will see. After them, write your answer from what you have.",
};

/** The call's value over the branch default over the defaults, field by
 *  field, so a call that sets only `text` keeps the branch's threshold. */
export function roundWarningSettings(
  perCall: WarnAtRoundsLeft | null | undefined,
  branch: WarnAtRoundsLeft | null | undefined,
): RoundWarningSettings {
  const withBranch = mergeFields<WarnAtRoundsLeft>(DEFAULT_ROUND_WARNING, branch);
  return mergeFields<WarnAtRoundsLeft>(withBranch, perCall) as RoundWarningSettings;
}

/** Fills `{remaining}` and `{limit}`. Any other brace text is left as
 *  written: the template is the user's text, so an unknown placeholder is
 *  not an error. */
export function fillRoundWarning(
  template: string,
  values: { remaining: number; limit: number },
): string {
  return template
    .replaceAll("{remaining}", String(values.remaining))
    .replaceAll("{limit}", String(values.limit));
}

/** Which warning, if any, is due at the boundary after `round` (counted
 *  from 0) under a cap of `limit`, given which have already gone out. At
 *  that boundary the model can still get `limit - (round + 1)` rounds of
 *  tool calls run. The final warning goes out at 1 left; the first at the
 *  first boundary at or under the threshold with more than 1 left, so the
 *  two are never due at once. */
export function roundWarningDue(
  settings: RoundWarningSettings,
  round: number,
  limit: number,
  fired: { first: boolean; final: boolean },
): { kind: "first" | "final"; text: string } | null {
  const remaining = limit - (round + 1);
  const values = { remaining, limit };
  if (!fired.final && settings.finalWarning && remaining === 1) {
    return { kind: "final", text: fillRoundWarning(settings.finalWarningText, values) };
  }
  if (!fired.first && settings.remaining > 0 && remaining <= settings.remaining && remaining > 1) {
    return { kind: "first", text: fillRoundWarning(settings.text, values) };
  }
  return null;
}

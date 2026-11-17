// The options a prompt for an interrupt can show, as one table. A prompt is
// an interrupt shown to a person. Everything that lists the options, reads
// a typed key, or asks what an option does reads this table, so a new
// option is one row here and its case in `policyAfterDecision`
// (interruptPromptOptions.ts).
//
// This file imports nothing, so interruptPrompts.ts, which must stay a leaf
// (see its header), can read the table.

/** What an option does. `approve` and `reject` answer this interrupt only.
 *  `approve-always` and `reject-always` also save a rule for the whole
 *  effect. `approve-always-here` saves a rule scoped to the interrupt's
 *  data, and `approve-always-set` saves that rule under every effect of a
 *  file-reading effect set. */
export type PromptDecision =
  | "approve"
  | "reject"
  | "approve-always"
  | "reject-always"
  | "approve-always-here"
  | "approve-always-set";

export type PromptOptionRow = {
  /** What a person types, or a front-end sends, to pick the option. */
  key: string;
  decision: PromptDecision;
  /** Which way the option answers the interrupt. The same two words as
   *  `InterruptResponse.type`. */
  response: "approve" | "reject";
  label: string;
  /** What a rule saved by this option covers: nothing (it answers once),
   *  the whole effect, the scope in the interrupt, or that scope under
   *  every effect of a shared set. */
  covers: "nothing" | "effect" | "scope" | "set";
};

/** Every option, in the order a prompt lists them. */
export const PROMPT_OPTION_ROWS: PromptOptionRow[] = [
  { key: "a", decision: "approve", response: "approve", label: "approve once", covers: "nothing" },
  {
    key: "aa",
    decision: "approve-always",
    response: "approve",
    label: "always approve",
    covers: "effect",
  },
  {
    key: "ap",
    decision: "approve-always-here",
    response: "approve",
    label: "always approve when",
    covers: "scope",
  },
  // The label gets the set's phrase and "in" added: "always approve all reads in".
  {
    key: "as",
    decision: "approve-always-set",
    response: "approve",
    label: "always approve",
    covers: "set",
  },
  { key: "r", decision: "reject", response: "reject", label: "reject once", covers: "nothing" },
  {
    key: "rr",
    decision: "reject-always",
    response: "reject",
    label: "always reject",
    covers: "effect",
  },
];

/** The row for a decision. Every decision has exactly one. */
export function rowForDecision(decision: PromptDecision): PromptOptionRow {
  const row = PROMPT_OPTION_ROWS.find((one) => one.decision === decision);
  if (row === undefined) {
    throw new Error(`No prompt option for the decision "${decision}".`);
  }
  return row;
}

/** Whether a decision approves the interrupt in front of the person. */
export function decisionApproves(decision: PromptDecision): boolean {
  return rowForDecision(decision).response === "approve";
}

/** Whether a decision is meant to cover later interrupts too. */
export function decisionIsRemembered(decision: PromptDecision): boolean {
  return rowForDecision(decision).covers !== "nothing";
}

/** The options that need nothing but the effect's name: the two that
 *  answer once and the two that cover the whole effect. The runtime's own
 *  terminal prompt offers these. They are listed with the one-time options
 *  first. */
export const EFFECT_WIDE_ROWS: PromptOptionRow[] = [
  ...PROMPT_OPTION_ROWS.filter((row) => row.covers === "nothing"),
  ...PROMPT_OPTION_ROWS.filter((row) => row.covers === "effect"),
];

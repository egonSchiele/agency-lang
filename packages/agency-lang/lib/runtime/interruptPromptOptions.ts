// What a front-end shows when it puts an interrupt in front of a person,
// and what the person's pick means. A prompt is an interrupt shown to a
// person: the terminal menu in std::policy is one, and a program with its
// own screen (an app) is another.
//
// Nothing here responds to an interrupt. Responding is `approve()`,
// `reject()` and `respondToInterrupts`. These functions are the data a
// prompt needs before that, and the bookkeeping after:
//
//   promptOptions        the options to show for an interrupt
//   resolvePromptOption  what picking one means: the response to give the
//                        run, and the policy with any rule the option saves
//
// See docs/dev/agents/approval-policies.md.
import { describeScope, folderChoices, inSharedApprovalSet } from "./alwaysChoices.js";
import { SHARED_APPROVAL_SETS, sharedApprovalSet } from "./alwaysChoices.js";
import type { FolderChoice } from "./alwaysChoices.js";
import type { ScopedField } from "./alwaysScope.js";
import type { EffectSetInfo } from "./effectSets.js";
import { PROMPT_OPTION_ROWS, rowForDecision } from "./interruptPromptTable.js";
import type { PromptDecision, PromptOptionRow } from "./interruptPromptTable.js";
import type { Intr } from "./interruptPrompts.js";
import { approve, reject } from "./interruptResponse.js";
import type { InterruptResponse } from "./interruptResponse.js";
import { checkPolicy, escapeGlob } from "./policy.js";
import type { Policy, PolicyDirs, PolicyRule } from "./policy.js";
import { insertApproveRule } from "./policyUpdate.js";
import { failure, success } from "./result.js";
import type { ResultFailure } from "./result.js";

/** How wide a saved rule can be. For a file read, a folder. */
export type PromptScope = {
  /** What a front-end sends back to pick this scope. */
  id: string;
  /** What the person reads. */
  label: string;
  /** A remark shown beside it: "the launch directory". */
  note?: string;
};

/** One option a prompt for an interrupt shows. */
export type PromptOption = {
  /** What a front-end sends back to pick this option: "ap". */
  key: string;
  label: string;
  /** Which way the option answers the interrupt. The same two words as
   *  `InterruptResponse.type`. */
  response: "approve" | "reject";
  /** What a rule saved by this option covers, in words. */
  detail?: string;
  /** The widths the saved rule can have, narrowest first. Empty for an
   *  option that saves no rule, or whose rule has one width. With two or
   *  more, the front-end asks which before it resolves the option. */
  scopes: PromptScope[];
};

/** What the options depend on besides the interrupt. */
export type PromptContext = {
  /** Per-effect scope overrides. An entry replaces the scope the effect
   *  declares, and an empty list turns the scoped options off for it. */
  overrides: Record<string, ScopedField[]>;
  /** The scopes effects declare with `@always` / `@alwaysUnder`. */
  registered: Record<string, ScopedField[]>;
  sets: Record<string, EffectSetInfo>;
  dirs: PolicyDirs;
};

/** The effect set a set-wide option covers. `members` is empty when the
 *  option is not offered. */
export type SharedSet = {
  name: string;
  /** What the option calls the set: "all reads". */
  phrase: string;
  members: string[];
};

const NO_SHARED_SET: SharedSet = { name: "", phrase: "", members: [] };

/** Text a model wrote, on its way to a person who is reading it in order
 *  to decide. Three groups come out:
 *
 *  - Control characters. An escape sequence moves the cursor or clears the
 *    screen; C1 codes do the same on terminals that decode them.
 *  - A lone carriage return, which returns the cursor to the start of the
 *    line so that whatever follows overwrites what came before it. CRLF is
 *    normalized to LF first, leaving a Windows file readable.
 *  - The bidi overrides and zero-width characters behind trojan source,
 *    which make code read as something other than what it runs as.
 *
 *  Tabs and newlines stay, because they are part of the code. */
export function stripControlChars(text: string): string {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/[؜​-‏‪-‮⁦-⁩﻿]/g, "");
}

/** The fields a rule for `effect` pins. The one resolution rule: an
 *  explicit override wins (an empty list turns the option off), and
 *  otherwise it is the scope the effect declares. Own keys only: `effect`
 *  is a string a program controls, and `constructor` must not resolve from
 *  the prototype. */
export function scopedFieldsFor(effect: string, context: PromptContext): ScopedField[] {
  if (Object.hasOwn(context.overrides, effect)) {
    return context.overrides[effect];
  }
  return Object.hasOwn(context.registered, effect) ? context.registered[effect] : [];
}

/** Glob patterns that pin an interrupt's scoped field values, as a rule's
 *  `match`. `{}` when the effect has no scope or a scoped value is missing:
 *  an empty `match` applies to every interrupt of the effect, so a caller
 *  must never make a rule from one. */
export function buildScopedMatch(intr: Intr, context: PromptContext): Record<string, string> {
  const data: Record<string, unknown> = intr.data ?? {};
  const match: Record<string, string> = {};
  for (const spec of scopedFieldsFor(intr.effect, context)) {
    const value = data[spec.field];
    if (value == null) {
      return {};
    }
    const literal = escapeGlob(`${value as string}`);
    match[spec.field] = spec.matchSubpaths ? `{${literal},${literal}/**}` : literal;
  }
  return match;
}

/** The interrupt's scope in words, or "" when it has none. */
function describeScopedMatch(intr: Intr, context: PromptContext): string {
  if (Object.keys(buildScopedMatch(intr, context)).length === 0) {
    return "";
  }
  return stripControlChars(describeScope(scopedFieldsFor(intr.effect, context), intr.data));
}

/** The one field whose rule can cover a wider folder, or "" when no rule
 *  for this interrupt can: the effect is in no shared set, or its scope
 *  does not have exactly one subpath field. */
export function folderField(intr: Intr, context: PromptContext): string {
  if (!inSharedApprovalSet(intr.effect, context.sets)) {
    return "";
  }
  const subpaths = scopedFieldsFor(intr.effect, context).filter((spec) => spec.matchSubpaths);
  return subpaths.length === 1 ? subpaths[0].field : "";
}

/** The folders a rule for this interrupt may cover. Empty when widening
 *  does not apply, and also when the folder is one a rule never covers:
 *  the home directory, the agent home, a folder holding either, or a
 *  filesystem root. */
export function folderOptions(intr: Intr, context: PromptContext): FolderChoice[] {
  const field = folderField(intr, context);
  const value: unknown = field === "" ? null : intr.data?.[field];
  if (value == null) {
    return [];
  }
  return folderChoices(`${value as string}`, context.dirs);
}

/** The set a set-wide option would cover. It is not offered when an
 *  override makes one member's scope differ, or when widening applies but
 *  there is no folder to offer: the rule would then cover, for every
 *  member, one of the folders a rule never covers. */
export function sharedSetFor(intr: Intr, context: PromptContext): SharedSet {
  const set = sharedApprovalSet(intr.effect, context.registered, context.overrides, context.sets);
  if (set === null) {
    return NO_SHARED_SET;
  }
  if (folderField(intr, context) !== "" && folderOptions(intr, context).length === 0) {
    return NO_SHARED_SET;
  }
  return { name: set.name, phrase: SHARED_APPROVAL_SETS[set.name], members: set.members };
}

type Offer = { scope: string; set: SharedSet };

function isOffered(row: PromptOptionRow, intr: Intr, offer: Offer): boolean {
  if (row.covers === "nothing") {
    return true;
  }
  // A raise that expects a value gets its own answer every time. A saved
  // rule would answer the next one with no value.
  if (intr.expectsValue === true) {
    return false;
  }
  if (row.covers === "effect") {
    return true;
  }
  // An empty scope would save a catch-all approve rule.
  if (row.covers === "scope") {
    return offer.scope !== "";
  }
  return offer.scope !== "" && offer.set.members.length > 0;
}

/** The widths to ask about. One folder is no choice, so it is not listed:
 *  `folderFor` uses it without asking. */
function scopesOf(folders: FolderChoice[]): PromptScope[] {
  if (folders.length < 2) {
    return [];
  }
  return folders.map((folder) => ({
    id: folder.path,
    label: stripControlChars(folder.path),
    ...(folder.note === "" ? {} : { note: folder.note }),
  }));
}

function optionFor(
  row: PromptOptionRow,
  intr: Intr,
  context: PromptContext,
  offer: Offer,
): PromptOption {
  const { key, label, response } = row;
  if (row.covers === "nothing") {
    return { key, label, response, scopes: [] };
  }
  if (row.covers === "effect") {
    return { key, label, response, detail: `every ${stripControlChars(intr.effect)}`, scopes: [] };
  }
  const scopes = scopesOf(folderOptions(intr, context));
  if (row.covers === "scope") {
    return { key, label, response, detail: offer.scope, scopes };
  }
  // "always approve all reads in   /x and below". The folder alone reads
  // after "in"; the field name would not.
  const field = folderField(intr, context);
  const where =
    field === "" ? offer.scope : stripControlChars(`${intr.data[field] as string} and below`);
  return { key, label: `${label} ${offer.set.phrase} in`, response, detail: where, scopes };
}

/** The options to show for `intr`, in the order a prompt lists them. */
export function promptOptions(intr: Intr, context: PromptContext): PromptOption[] {
  const offer: Offer = {
    scope: describeScopedMatch(intr, context),
    set: sharedSetFor(intr, context),
  };
  return PROMPT_OPTION_ROWS.filter((row) => isOffered(row, intr, offer)).map((row) =>
    optionFor(row, intr, context, offer),
  );
}

/** The decision a key stands for, or null when `key` is not one of
 *  `offeredKeys`. A prompt offers a raise that expects a value only the
 *  one-time options, so "aa" typed there is not a decision. */
export function decisionForOfferedKey(key: string, offeredKeys: string[]): PromptDecision | null {
  if (!offeredKeys.includes(key)) {
    return null;
  }
  return PROMPT_OPTION_ROWS.find((row) => row.key === key)?.decision ?? null;
}

/** `policy` with an effect-wide rule appended. */
export function recordRule(policy: Policy, effect: string, action: "approve" | "reject"): Policy {
  return { ...policy, [effect]: [...(policy[effect] ?? []), { action }] };
}

/** The effects among `effects` a set-wide rule is saved under: those the
 *  policy does not already reject for this interrupt. A rule saved under
 *  an effect that rejects it would sit behind that reject and never decide
 *  anything. */
export function unrejectedEffects(args: {
  policy: Policy;
  intr: Intr;
  effects: string[];
  dirs: PolicyDirs;
}): string[] {
  const { policy, intr, effects, dirs } = args;
  return effects.filter(
    (effect) => checkPolicy(policy, { ...intr, effect }, dirs).type !== "reject",
  );
}

/** One scoped approve rule under each of `effects`, placed just after each
 *  effect's reject rules, so no reject the user saved is overturned by a
 *  grant for a folder that holds it. `folder` replaces the folder in the
 *  interrupt when a wider one was picked. The rule matches dot folders
 *  only for an effect in a shared set: those effects only read, and a
 *  folder a rule may cover is never the home directory. */
function withScopedRule(args: {
  policy: Policy;
  intr: Intr;
  effects: string[];
  folder: string;
  context: PromptContext;
}): Policy {
  const { policy, intr, effects, folder, context } = args;
  const subject: Intr =
    folder === ""
      ? intr
      : { ...intr, data: { ...intr.data, [folderField(intr, context)]: folder } };
  const match = buildScopedMatch(subject, context);
  if (Object.keys(match).length === 0) {
    return policy;
  }
  const rule: PolicyRule = { match, action: "approve" };
  if (folder !== "" && inSharedApprovalSet(intr.effect, context.sets)) {
    rule.matchDotFolders = true;
  }
  return insertApproveRule(policy, effects, rule);
}

/** `policy` with the rule `decision` saves for `intr`. The same policy for
 *  a decision that answers once, and for a raise that expects a value: an
 *  effect-wide rule would answer every later raise of the effect, each of
 *  which wants its own answer. `folder` is "" when no wider folder
 *  applies. A caller that got `folder` from outside the program must check
 *  it first; `resolvePromptOption` does. */
export function policyAfterDecision(args: {
  policy: Policy;
  intr: Intr;
  decision: PromptDecision;
  folder: string;
  context: PromptContext;
}): Policy {
  const { policy, intr, decision, folder, context } = args;
  if (intr.expectsValue === true) {
    return policy;
  }
  switch (decision) {
    case "approve":
    case "reject":
      return policy;
    case "approve-always":
      return recordRule(policy, intr.effect, "approve");
    case "reject-always":
      return recordRule(policy, intr.effect, "reject");
    case "approve-always-here":
      return withScopedRule({ policy, intr, effects: [intr.effect], folder, context });
    case "approve-always-set": {
      const effects = unrejectedEffects({
        policy,
        intr,
        effects: sharedSetFor(intr, context).members,
        dirs: context.dirs,
      });
      return withScopedRule({ policy, intr, effects, folder, context });
    }
  }
}

/** The folder a scoped rule covers. With no folder to widen to it is "",
 *  with one it is that one, and with more the caller must name one of
 *  them. */
function folderFor(args: {
  row: PromptOptionRow;
  folders: FolderChoice[];
  scope: string | undefined;
}): string | ResultFailure {
  const { row, folders, scope } = args;
  const widens = row.covers === "scope" || row.covers === "set";
  const offered = widens && folders.length > 1 ? folders.map((folder) => folder.path) : [];
  if (offered.length === 0) {
    if (scope !== undefined) {
      return failure(`The option "${row.key}" has no scope to pick, but one was given.`);
    }
    return widens && folders.length === 1 ? folders[0].path : "";
  }
  if (scope === undefined) {
    return failure(`The option "${row.key}" needs one of its scopes.`);
  }
  if (!offered.includes(scope)) {
    return failure(`"${scope}" is not one of the scopes the option "${row.key}" offers.`);
  }
  return scope;
}

export type ResolvedPromptOption = { response: InterruptResponse; policy: Policy };

export type ResolvedPromptOptionResult =
  { __type: "resultType"; success: true; value: ResolvedPromptOption } | ResultFailure;

/** What picking an option means: the response to give the run through
 *  `respondToInterrupts`, and `policy` with the rule the option saves (the
 *  same policy for an option that saves none). A failure when `key` is not
 *  an option this interrupt offers, or `scope` is not one of that option's
 *  scopes: both may come from a client, so neither is trusted.
 *
 *  This does not respond to the interrupt. */
export function resolvePromptOption(args: {
  intr: Intr;
  key: string;
  /** The `id` of the scope picked. Omit it when the option lists none. */
  scope?: string;
  policy: Policy;
  context: PromptContext;
}): ResolvedPromptOptionResult {
  const { intr, key, scope, policy, context } = args;
  const offeredKeys = promptOptions(intr, context).map((option) => option.key);
  const decision = decisionForOfferedKey(key, offeredKeys);
  if (decision === null) {
    return failure(`"${key}" is not one of the options this interrupt offers.`);
  }
  const row = rowForDecision(decision);
  const folder = folderFor({ row, folders: folderOptions(intr, context), scope });
  if (typeof folder !== "string") {
    return folder;
  }
  return success({
    response: row.response === "approve" ? approve() : reject(),
    policy: policyAfterDecision({ policy, intr, decision, folder, context }),
  }) as ResolvedPromptOptionResult;
}

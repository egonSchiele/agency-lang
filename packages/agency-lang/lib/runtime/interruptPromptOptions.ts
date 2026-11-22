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
import { describeScope, folderChoices, getsFolderStep } from "./alwaysChoices.js";
import { EXACT_PREFIX, prefixChoices, prefixPattern } from "./alwaysChoices.js";
import { SHARED_APPROVAL_SETS, sharedApprovalSet } from "./alwaysChoices.js";
import type { FolderChoice } from "./alwaysChoices.js";
import type { ScopedField } from "./alwaysScope.js";
import type { EffectSetInfo } from "./effectSets.js";
import { PROMPT_OPTION_ROWS, rowForDecision } from "./interruptPromptTable.js";
import type { PromptDecision, PromptOptionRow } from "./interruptPromptTable.js";
import type { Intr } from "./interruptPrompts.js";
import { approve, reject } from "./interruptResponse.js";
import type { InterruptResponse } from "./interruptResponse.js";
import { checkPolicy, escapeGlob, MAX_PATTERN_LENGTH } from "./policy.js";
import type { MatchPattern, Policy, PolicyDirs, PolicyRule } from "./policy.js";
import { insertApproveRule, insertRejectRule } from "./policyUpdate.js";
import { failure, success } from "./result.js";
import type { ResultFailure } from "./result.js";

/** One choice in a follow-up question: a folder, or how much of a command. */
export type PromptScope = {
  /** What a front-end sends back to pick this choice. */
  id: string;
  /** What the person reads. */
  label: string;
  /** A remark shown beside it: "the launch directory". */
  note?: string;
};

/** One follow-up question an option asks before its rule is saved. */
export type PromptStep = {
  /** Which part of the rule this step widens. */
  id: "items" | "folder";
  /** "Which commands should this cover?" */
  question: string;
  /** The choices, narrowest first. Always two or more. */
  choices: PromptScope[];
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
  /** The questions to ask, in order, before the option is resolved. Empty
   *  for an option that saves no rule, or whose rule has one width. */
  steps: PromptStep[];
};

/** The widths of the rule an option saves, one per step id. "" for a part
 *  that does not apply to this interrupt. */
export type RulePicks = { items: string; folder: string };

/** The picks that need no question. A part is null when the person must
 *  choose it. */
export type KnownPicks = { items: string | null; folder: string | null };

type StepId = PromptStep["id"];

// The tag is general, but std::exec is its only user, so the words are a
// command's. A second effect with `@alwaysPrefix` needs general wording.
const ITEMS_QUESTION = "Which commands should this cover?";
const EXACT_ITEMS_NOTE = "this exact command";
const FOLDER_QUESTION = "Which folder should this cover?";

/** How much of one argument a choice's label shows. The body above the
 *  menu shows the whole command. */
const MAX_LABEL_ITEM = 60;

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
    .replace(/[\u{61c}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu, "");
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
 *  `match`. `prefix` is the id of the `PrefixChoice` picked for a field
 *  tagged `@alwaysPrefix`; it defaults to the whole list. `{}` when the
 *  effect has no scope, a scoped value is missing or has the wrong shape,
 *  `prefix` is not a choice for the list, or a pattern would be longer
 *  than a rule may hold: an empty `match` applies to every interrupt of
 *  the effect, so a caller must never make a rule from one. */
export function buildScopedMatch(
  intr: Intr,
  context: PromptContext,
  prefix: string = EXACT_PREFIX,
): Record<string, MatchPattern> {
  const data: Record<string, unknown> = intr.data ?? {};
  const match: Record<string, MatchPattern> = {};
  for (const spec of scopedFieldsFor(intr.effect, context)) {
    const pattern = fieldPattern(spec, data[spec.field], prefix);
    if (pattern === null) {
      return {};
    }
    match[spec.field] = pattern;
  }
  return match;
}

/** The pattern that pins one field, or null when no rule can pin it. A
 *  list takes the list branch: a prefix field with the choice picked, and
 *  a list under plain `@always` with the whole list. */
function fieldPattern(spec: ScopedField, value: unknown, prefix: string): MatchPattern | null {
  if (value == null) {
    return null;
  }
  if (spec.matchPrefix === true || Array.isArray(value)) {
    return listPattern(value, spec.matchPrefix === true ? prefix : EXACT_PREFIX);
  }
  const literal = escapeGlob(`${value as string}`);
  const pattern = spec.matchSubpaths ? `{${literal},${literal}/**}` : literal;
  return fitsInRule(pattern) ? pattern : null;
}

function listPattern(value: unknown, prefix: string): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return null;
  }
  const choice = prefixChoices(value.length).find((one) => one.id === prefix);
  if (choice === undefined) {
    return null;
  }
  const pattern = prefixPattern(value, choice);
  return pattern.every(fitsInRule) ? pattern : null;
}

function fitsInRule(pattern: string): boolean {
  return pattern.length <= MAX_PATTERN_LENGTH;
}

/** The interrupt's scope in words, or "" when it has none. */
function describeScopedMatch(intr: Intr, context: PromptContext): string {
  if (Object.keys(buildScopedMatch(intr, context)).length === 0) {
    return "";
  }
  return stripControlChars(describeScope(scopedFieldsFor(intr.effect, context), intr.data));
}

/** The one field whose rule can cover a wider folder, or "" when no rule
 *  for this interrupt can: the effect does not get the folder step
 *  (`getsFolderStep`), or its scope does not have exactly one subpath
 *  field. */
export function folderField(intr: Intr, context: PromptContext): string {
  if (!getsFolderStep(intr.effect, context.sets)) {
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

function folderScopes(folders: FolderChoice[]): PromptScope[] {
  return folders.map((folder) => ({
    id: folder.path,
    label: stripControlChars(folder.path),
    ...(folder.note === "" ? {} : { note: folder.note }),
  }));
}

/** The list a rule for this interrupt pins the start of, or null when the
 *  scope has no `@alwaysPrefix` field or its value is not a list of
 *  strings. */
function prefixList(intr: Intr, context: PromptContext): string[] | null {
  const spec = scopedFieldsFor(intr.effect, context).find((one) => one.matchPrefix === true);
  const value: unknown = spec === undefined ? null : intr.data?.[spec.field];
  const isList = Array.isArray(value) && value.every((item) => typeof item === "string");
  return isList ? (value as string[]) : null;
}

function shortened(item: string): string {
  return item.length > MAX_LABEL_ITEM ? `${item.slice(0, MAX_LABEL_ITEM)}…` : item;
}

/** How much of a list the rule may cover, narrowest first. A label is the
 *  values of the exact fields, then the kept items, then "…" for "and any
 *  items after these": `pnpm run …`. Empty when the scope has no
 *  `@alwaysPrefix` field. */
export function itemChoices(intr: Intr, context: PromptContext): PromptScope[] {
  const items = prefixList(intr, context);
  if (items === null) {
    return [];
  }
  const lead = scopedFieldsFor(intr.effect, context)
    .filter((spec) => !spec.matchSubpaths && spec.matchPrefix !== true)
    .map((spec) => String(intr.data?.[spec.field]));
  return prefixChoices(items.length).map((choice) => {
    const kept = items.slice(0, choice.keep).map(shortened);
    const words = choice.rest ? [...lead, ...kept, "…"] : [...lead, ...kept];
    const label = stripControlChars(words.join(" "));
    return choice.rest
      ? { id: choice.id, label }
      : { id: choice.id, label, note: EXACT_ITEMS_NOTE };
  });
}

/** Every choice for one part of the rule, a single one included. */
function choicesFor(part: StepId, intr: Intr, context: PromptContext): PromptScope[] {
  return part === "items" ? itemChoices(intr, context) : folderScopes(folderOptions(intr, context));
}

/** The questions to ask. A part with one choice is no question, so it is
 *  not listed: `picksWithoutAsking` returns its choice. */
function stepsFor(intr: Intr, context: PromptContext): PromptStep[] {
  const steps: PromptStep[] = [
    { id: "items", question: ITEMS_QUESTION, choices: choicesFor("items", intr, context) },
    { id: "folder", question: FOLDER_QUESTION, choices: choicesFor("folder", intr, context) },
  ];
  return steps.filter((step) => step.choices.length > 1);
}

function optionFor(
  row: PromptOptionRow,
  intr: Intr,
  context: PromptContext,
  offer: Offer,
): PromptOption {
  const { key, label, response } = row;
  if (row.covers === "nothing") {
    return { key, label, response, steps: [] };
  }
  if (row.covers === "effect") {
    return { key, label, response, detail: `every ${stripControlChars(intr.effect)}`, steps: [] };
  }
  const steps = stepsFor(intr, context);
  if (row.covers === "scope") {
    return { key, label, response, detail: offer.scope, steps };
  }
  // "always approve all reads in   /x and below". The folder alone reads
  // after "in"; the field name would not.
  const field = folderField(intr, context);
  const where =
    field === "" ? offer.scope : stripControlChars(`${intr.data[field] as string} and below`);
  return { key, label: `${label} ${offer.set.phrase} in`, response, detail: where, steps };
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

/** `policy` with an effect-wide rule appended. This is std::policy's
 *  `recordRule`. The prompt's "always" options do not use it: see
 *  `policyAfterDecision`. */
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
 *  grant for a folder that holds it. `picks.folder` replaces the folder in
 *  the interrupt when a wider one was picked, and `picks.items` is how
 *  much of a list the rule pins. The rule matches dot folders only for an
 *  effect that gets the folder step (`getsFolderStep`), and a folder a rule
 *  may cover is never the home directory. */
function withScopedRule(args: {
  policy: Policy;
  intr: Intr;
  effects: string[];
  picks: RulePicks;
  context: PromptContext;
}): Policy {
  const { policy, intr, effects, picks, context } = args;
  const { folder, items } = picks;
  const subject: Intr =
    folder === ""
      ? intr
      : { ...intr, data: { ...intr.data, [folderField(intr, context)]: folder } };
  const match = buildScopedMatch(subject, context, items);
  if (Object.keys(match).length === 0) {
    return policy;
  }
  const rule: PolicyRule = { match, action: "approve" };
  if (folder !== "" && getsFolderStep(intr.effect, context.sets)) {
    rule.matchDotFolders = true;
  }
  return insertApproveRule(policy, effects, rule);
}

/** `policy` with the rule `decision` saves for `intr`. The same policy for
 *  a decision that answers once, and for a raise that expects a value: an
 *  effect-wide rule would answer every later raise of the effect, each of
 *  which wants its own answer. `picks` are the widths of the rule; take
 *  them from `picksWithoutAsking` and from the person's answers. A caller
 *  that got them from outside the program must check them first;
 *  `resolvePromptOption` does. */
export function policyAfterDecision(args: {
  policy: Policy;
  intr: Intr;
  decision: PromptDecision;
  picks: RulePicks;
  context: PromptContext;
}): Policy {
  const { policy, intr, decision, picks, context } = args;
  if (intr.expectsValue === true) {
    return policy;
  }
  switch (decision) {
    case "approve":
    case "reject":
      return policy;
    // An effect-wide rule appended after a catch-all would never decide,
    // and the same pick would append it again each time. These two place
    // it where it decides and save it once.
    case "approve-always":
      return insertApproveRule(policy, [intr.effect], { action: "approve" });
    case "reject-always":
      return insertRejectRule(policy, [intr.effect], { action: "reject" });
    case "approve-always-here":
      return withScopedRule({ policy, intr, effects: [intr.effect], picks, context });
    case "approve-always-set": {
      const effects = unrejectedEffects({
        policy,
        intr,
        effects: sharedSetFor(intr, context).members,
        dirs: context.dirs,
      });
      return withScopedRule({ policy, intr, effects, picks, context });
    }
  }
}

/** The pick for a part with nothing to ask: "" when it has no choices, and
 *  the choice when there is exactly one. null when there are several. */
function onlyChoice(choices: PromptScope[]): string | null {
  if (choices.length > 1) {
    return null;
  }
  return choices.length === 1 ? choices[0].id : "";
}

/** The widths of the rule `decision` saves that need no question. This is
 *  the one place that rule lives. The terminal's steps and
 *  `resolvePromptOption` both ask it, so they save the same rule for the
 *  same picks. */
export function picksWithoutAsking(
  intr: Intr,
  decision: PromptDecision,
  context: PromptContext,
): KnownPicks {
  const { covers } = rowForDecision(decision);
  if (covers !== "scope" && covers !== "set") {
    return { items: "", folder: "" };
  }
  return {
    items: onlyChoice(choicesFor("items", intr, context)),
    folder: onlyChoice(choicesFor("folder", intr, context)),
  };
}

/** The pick for one part, given what a caller sent. A caller must send one
 *  exactly when the person had to pick, and it must be one of the choices
 *  offered. */
function pickFor(args: {
  part: StepId;
  known: string | null;
  sent: string | undefined;
  offered: PromptScope[];
  key: string;
}): string | ResultFailure {
  const { part, known, sent, offered, key } = args;
  if (known !== null) {
    return sent === undefined
      ? known
      : failure(`The option "${key}" has no ${part} step, but a ${part} pick was given.`);
  }
  if (sent === undefined) {
    return failure(`The option "${key}" needs a pick for its ${part} step.`);
  }
  if (!offered.some((choice) => choice.id === sent)) {
    return failure(
      `"${sent}" is not one of the choices for the ${part} step of the option "${key}".`,
    );
  }
  return sent;
}

/** Every part's pick, checked. */
function picksFor(args: {
  intr: Intr;
  row: PromptOptionRow;
  picks: Partial<RulePicks>;
  context: PromptContext;
}): RulePicks | ResultFailure {
  const { intr, row, picks, context } = args;
  const known = picksWithoutAsking(intr, row.decision, context);
  const pickOf = (part: StepId) =>
    pickFor({
      part,
      known: known[part],
      sent: picks[part],
      offered: choicesFor(part, intr, context),
      key: row.key,
    });
  const items = pickOf("items");
  if (typeof items !== "string") {
    return items;
  }
  const folder = pickOf("folder");
  if (typeof folder !== "string") {
    return folder;
  }
  return { items, folder };
}

export type ResolvedPromptOption = { response: InterruptResponse; policy: Policy };

export type ResolvedPromptOptionResult =
  { __type: "resultType"; success: true; value: ResolvedPromptOption } | ResultFailure;

/** What picking an option means: the response to give the run through
 *  `respondToInterrupts`, and `policy` with the rule the option saves (the
 *  same policy for an option that saves none). A failure when `key` is not
 *  an option this interrupt offers, or `picks` does not hold exactly one
 *  offered choice per step the option listed: both may come from a client,
 *  so neither is trusted.
 *
 *  `intr` IS trusted, and the rule saved is built from `intr.data`. It
 *  must be the host's own copy of the interrupt, looked up by the
 *  `interruptId` the client sent, and never an interrupt a client sent
 *  back. A client that could supply `data` could name any folder and have
 *  an approve rule saved for it.
 *
 *  This does not respond to the interrupt. */
export function resolvePromptOption(args: {
  intr: Intr;
  key: string;
  /** The `id` of the choice picked at each step the option listed, keyed
   *  by step id. Leave out a step the option did not list. */
  picks?: Partial<RulePicks>;
  policy: Policy;
  context: PromptContext;
}): ResolvedPromptOptionResult {
  const { intr, key, policy, context } = args;
  const offeredKeys = promptOptions(intr, context).map((option) => option.key);
  const decision = decisionForOfferedKey(key, offeredKeys);
  if (decision === null) {
    return failure(`"${key}" is not one of the options this interrupt offers.`);
  }
  const row = rowForDecision(decision);
  const picks = picksFor({ intr, row, picks: args.picks ?? {}, context });
  if ("__type" in picks) {
    return picks;
  }
  return success({
    response: row.response === "approve" ? approve() : reject(),
    policy: policyAfterDecision({ policy, intr, decision, picks, context }),
  }) as ResolvedPromptOptionResult;
}

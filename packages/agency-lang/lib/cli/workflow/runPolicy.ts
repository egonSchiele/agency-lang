/**
 * The policy `agency workflow run` runs a workflow under. It is built from
 * three parts, in this order for each effect:
 *
 * 1. The person's own rules, unchanged. A policy's first matching rule
 *    wins, so they decide first.
 * 2. The start rules, which approve the prompts the run node raises before
 *    the first step. Typing the command is consent to start the workflow.
 * 3. One approve rule for each effect the person accepted at the prompt.
 *
 * Then a "*" rule rejects everything else. When the person's policy has
 * its own "*" rule, none of this is added: they meant it to decide
 * everything.
 */
import { escapeGlob, type Policy, type PolicyRule } from "../../runtime/policy.js";
import type { StepEffects } from "../../stdlib/workflow/effects.js";
import { effectSteps, type EffectSteps } from "./output.js";

const WILDCARD = "*";

/** What a step rejected by the run's catch-all says, so the person knows
 *  the rejection came from `agency workflow run` and not from a rule of
 *  theirs. */
export const CATCH_ALL_MESSAGE =
  "rejected by agency workflow run: no rule in your policy approves this, and it was not approved at the prompt";

/** One effect the person's policy does not cover, and the steps that raise it. */
export type Uncovered = EffectSteps;

/** The effects in `steps` that `policy` has no rule for. With a "*" key,
 *  nothing is uncovered. Each step is written `<id> (<tool>)`. */
export function uncoveredEffects(steps: StepEffects[], policy: Policy): Uncovered[] {
  if (Object.hasOwn(policy, WILDCARD)) {
    return [];
  }
  return effectSteps(steps).filter(({ effect }) => !Object.hasOwn(policy, effect));
}

export type StartPrompts = {
  name: string;
  /** The absolute directory runWorkflow is given, from `path.resolve`. */
  dir: string;
  /** `<real project dir>/workflows`, from `fs.realpathSync`, as loadWorkflow spells it. */
  workflowsDir: string;
  /** Each local tool module as `read` spells it. */
  moduleReads: { dir: string; filename: string }[];
};

function approveMatching(match: Record<string, string>): PolicyRule {
  const escaped: Record<string, string> = {};
  for (const [key, value] of Object.entries(match)) {
    escaped[key] = escapeGlob(value);
  }
  return { match: escaped, action: "approve" };
}

/** The rules that approve what the run node raises before the first step:
 *  loadWorkflow's scan, then what runWorkflow raises. The std::run rule
 *  pins the node and depth but not the module, which approves nothing
 *  extra: the only depth-1 `run` in the driver is runWorkflow's, and a tool
 *  that calls `run` does so inside the child, at depth 2. */
export function startRules(start: StartPrompts): Policy {
  return {
    "std::workflow::scan": [approveMatching({ dir: start.workflowsDir })],
    "std::workflow::run": [approveMatching({ name: start.name, dir: start.dir })],
    "std::run": [approveMatching({ node: "main", depth: "1" })],
    "std::read": start.moduleReads.map((read) =>
      approveMatching({ dir: read.dir, filename: read.filename }),
    ),
  };
}

/** The run's policy. With a "*" key in `person`, it is `person` unchanged.
 *  Otherwise each effect's rules are the person's, then the start rules,
 *  then one approve for an accepted effect, and a "*" rule rejects the rest. */
export function runPolicy(person: Policy, start: Policy, accepted: string[]): Policy {
  if (Object.hasOwn(person, WILDCARD)) {
    return person;
  }
  const effects = [...Object.keys(person), ...Object.keys(start), ...accepted].filter(
    (effect, index, all) => all.indexOf(effect) === index,
  );
  // Null prototype: an effect name such as "__proto__" stays a plain key.
  const policy: Policy = Object.create(null);
  for (const effect of effects) {
    policy[effect] = [
      ...(person[effect] ?? []),
      ...(start[effect] ?? []),
      ...(accepted.includes(effect) ? [{ action: "approve" as const }] : []),
    ];
  }
  policy[WILDCARD] = [{ action: "reject", rejectMessage: CATCH_ALL_MESSAGE }];
  return policy;
}

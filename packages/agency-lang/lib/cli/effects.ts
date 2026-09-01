import { builtinEffectSets, type EffectSetInfo } from "@/runtime/effectSets.js";
import { ttyColor } from "@/utils/termcolors.js";
import { nearMissSetName } from "@/runtime/policyFlags.js";
import { BUILTIN_POLICIES, builtinPolicy, builtinPolicyNames } from "@/runtime/builtinPolicies.js";
import type { Policy } from "@/runtime/policy.js";

type PolicyEntry = { name: string; description: string };

/**
 * `agency effects [name]`: what the approval flags accept. With no
 * argument, list the built-in capability sets and policies. With a set
 * name, describe the set; with an effect name (contains `::`), name the
 * sets that include it; with a built-in policy name, print its resolved
 * policy. Plain text, with `ttyColor` accents that noop when stdout is
 * not a TTY.
 */
export function effectsCmd(name?: string): void {
  let sets: Record<string, EffectSetInfo>;
  try {
    sets = builtinEffectSets();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  if (name === undefined) {
    process.stdout.write(renderEffectsList(sets, BUILTIN_POLICIES));
    return;
  }
  if (name.includes("::")) {
    process.stdout.write(renderEffectLookup(name, sets));
    return;
  }
  const policy = BUILTIN_POLICIES.find((p) => p.name === name);
  if (policy !== undefined) {
    // Resolved against the process cwd, like `--policy <name>` at launch,
    // so dir-scoped rules show the paths they would really match.
    process.stdout.write(
      renderPolicyDetail(policy.name, policy.description, builtinPolicy(name, process.cwd())!),
    );
    return;
  }
  const set = sets[name];
  if (set !== undefined) {
    process.stdout.write(renderSetDetail(set));
    return;
  }
  console.error(renderUnknownName(name, sets, builtinPolicyNames()));
  process.exit(1);
}

/** The first sentence of a doc comment, newlines collapsed. A period
 *  counts as a boundary only when the next sentence begins (whitespace
 *  then an uppercase letter), so an abbreviation mid-sentence — the
 *  Calendar set's "(incl. calendar authorization)" — does not truncate. */
export function firstSentence(doc: string): string {
  const flat = doc.replace(/\s+/g, " ").trim();
  const boundary = flat.match(/\.(?=\s+[A-Z])/);
  return boundary?.index === undefined ? flat : flat.slice(0, boundary.index + 1);
}

function twoColumn(rows: [string, string][]): string {
  const width = Math.max(...rows.map(([name]) => name.length)) + 2;
  // Pad before coloring: ANSI codes would count toward padEnd's width.
  return rows.map(([name, text]) => `  ${ttyColor.cyan(name.padEnd(width))}${text}`).join("\n");
}

export function renderEffectsList(
  sets: Record<string, EffectSetInfo>,
  policies: PolicyEntry[],
): string {
  const setRows = Object.values(sets).map(
    (set) => [set.name, firstSentence(set.doc)] as [string, string],
  );
  const policyRows = policies.map((p) => [p.name, p.description] as [string, string]);
  return [
    ttyColor.bold("Effect sets:"),
    twoColumn(setRows),
    "",
    ttyColor.bold("Built-in policies:"),
    twoColumn(policyRows),
    "",
    "Use a set or an effect name with --approve / --reject, a policy with --policy:",
    "  agency agent --policy with-writes --reject Shell",
    "Run `agency effects <name>` for one set, effect, or policy in full.",
    "",
  ].join("\n");
}

export function renderSetDetail(set: EffectSetInfo): string {
  const lines = [ttyColor.bold(set.name), "", set.doc, ""];
  if (set.composedOf.length > 0) {
    lines.push(`${set.name} = ${set.composedOf.join(" + ")}`, "");
  }
  lines.push(ttyColor.bold("Member effects:"));
  for (const member of set.members) {
    lines.push(`  ${ttyColor.cyan(member)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderEffectLookup(effect: string, sets: Record<string, EffectSetInfo>): string {
  const containing = Object.values(sets).filter((set) => set.members.includes(effect));
  if (containing.length === 0) {
    return `No built-in set includes ${effect}. It can still be named directly in --approve / --reject.\n`;
  }
  const lines = [ttyColor.bold(`Sets that include ${effect}:`)];
  for (const set of containing) {
    lines.push(`  ${ttyColor.cyan(set.name)}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderPolicyDetail(name: string, description: string, policy: Policy): string {
  return [ttyColor.bold(name), "", description, "", JSON.stringify(policy, null, 2), ""].join("\n");
}

export function renderUnknownName(
  name: string,
  sets: Record<string, EffectSetInfo>,
  policyNames: string[],
): string {
  const near = nearMissSetName(name, [...Object.keys(sets), ...policyNames]);
  const hint = near === null ? "" : ` Did you mean ${near}?`;
  return (
    `"${name}" is not a built-in effect set or policy.${hint} ` +
    `Run \`agency effects\` for the full list. Effect names (usually namespaced, like std::read, though bare names are legal too) can be passed to --approve / --reject directly.`
  );
}

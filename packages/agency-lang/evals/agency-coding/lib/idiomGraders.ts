// Graders for HOW a solution is written, for tests where the holdout
// harness already checks what it does. Each one parses the saved outFile
// with the real Agency parser and inspects the unlowered AST, so a score
// is a fact about the source, not a judge's opinion.
import * as fs from "fs";
import * as path from "path";

import { parseAgency } from "agency-lang";
import { binary, grader, type Grader, type Test } from "agency-lang/eval";

/** Mirrors `CodingEvalInput` in stdlib/agents/agency/coding.agency. */
type CodingInput = { assignment: string; outFile: string };
type CodingGrader = Grader<CodingInput>;

/** An AST node as this file walks it: a `type` tag and whatever else. */
type Node = { type?: string; [key: string]: unknown };

/** The solution's AST, or null when the file is missing or does not parse. */
export function parseSolution(workdir: string, test: Test<CodingInput>): Node | null {
  if (!test.input?.outFile) return null;
  const root = path.resolve(workdir);
  const resolved = path.resolve(root, test.input.outFile);
  if (!resolved.startsWith(root + path.sep)) return null;
  let source: string;
  try {
    source = fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
  const parsed = parseAgency(source, {}, true, false);
  return parsed.success ? (parsed.result as Node) : null;
}

/** Every node in the tree, depth first. */
export function nodes(tree: unknown): Node[] {
  const found: Node[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === "object") {
      const node = value as Node;
      if (typeof node.type === "string") found.push(node);
      for (const [key, child] of Object.entries(node)) {
        if (key !== "loc") walk(child);
      }
    }
  };
  walk(tree);
  return found;
}

const isAccessTo = (node: unknown, property: string): boolean => {
  const access = node as Node;
  if (access?.type !== "valueAccess") return false;
  const chain = access.chain as { kind: string; name?: string }[];
  return chain[chain.length - 1]?.name === property;
};

/** The match blocks whose scrutinee is `<something>.effect`. */
const matchesOnEffect = (tree: Node): Node[] =>
  nodes(tree).filter((n) => n.type === "matchBlock" && isAccessTo(n.expression, "effect"));

/** Every handler body in the tree (inline `with (data) { ... }` handlers). */
const handlerBodies = (tree: Node): unknown[] =>
  nodes(tree)
    .filter((n) => n.type === "handleBlock")
    .map((n) => (n.handler as Node | undefined)?.body);

/** The handler decides with one `match` on the interrupt's effect name. */
function matchesOnEffectInHandler(): CodingGrader {
  return grader<CodingInput>(
    ({ workdir, test }) => {
      const tree = parseSolution(workdir, test);
      if (tree === null) return binary(false, "solution missing or does not parse");
      const inHandler = handlerBodies(tree).some(
        (body) => matchesOnEffect({ type: "body", body }).length > 0,
      );
      return binary(
        inHandler,
        inHandler
          ? "handler matches on data.effect"
          : "no match on the effect name inside a handler",
      );
    },
    { name: "match-on-effect" },
  );
}

/** No arm of the decision is an if-chain comparing the effect name. */
function noIfChainOnEffect(): CodingGrader {
  return grader<CodingInput>(
    ({ workdir, test }) => {
      const tree = parseSolution(workdir, test);
      if (tree === null) return binary(false, "solution missing or does not parse");
      const ifs = nodes(tree).filter((n) => n.type === "ifElse");
      const onEffect = ifs.filter((n) =>
        nodes(n.condition).some((c) => c.type === "valueAccess" && isAccessTo(c, "effect")),
      );
      return binary(
        onEffect.length === 0,
        onEffect.length === 0
          ? "no if on the effect name"
          : `${onEffect.length} if statement(s) compare the effect name`,
      );
    },
    { name: "no-if-chain-on-effect" },
  );
}

/** The conditional write decision is a guard arm (`"std::write" if (...) =>`),
 *  not an if inside the arm body. */
function guardArmForConditionalWrite(): CodingGrader {
  return grader<CodingInput>(
    ({ workdir, test }) => {
      const tree = parseSolution(workdir, test);
      if (tree === null) return binary(false, "solution missing or does not parse");
      const guarded = matchesOnEffect(tree)
        .flatMap((m) => m.cases as Node[])
        .filter((arm) => arm.guard !== undefined);
      return binary(
        guarded.length > 0,
        guarded.length > 0
          ? "a guard arm carries the dir condition"
          : "no guard arm on the effect match",
      );
    },
    { name: "guard-arm" },
  );
}

/** The Result from foo is unwrapped with `match`, not `is success` checks. */
function matchesOnResult(): CodingGrader {
  return grader<CodingInput>(
    ({ workdir, test }) => {
      const tree = parseSolution(workdir, test);
      if (tree === null) return binary(false, "solution missing or does not parse");
      const resultMatch = nodes(tree).some(
        (n) =>
          n.type === "matchBlock" &&
          (n.cases as Node[]).some((arm) => (arm.caseValue as Node)?.type === "resultPattern"),
      );
      return binary(
        resultMatch,
        resultMatch ? "Result unwrapped with match" : "Result not unwrapped with match",
      );
    },
    { name: "match-on-result" },
  );
}

/** The graders for a test whose solution decides interrupts in a handler. */
export function handlerIdiomGraders(): CodingGrader[] {
  return [
    matchesOnEffectInHandler(),
    noIfChainOnEffect(),
    guardArmForConditionalWrite(),
    matchesOnResult(),
  ];
}

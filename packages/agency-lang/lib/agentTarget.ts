import * as fs from "fs";
import * as path from "path";

import {
  MISSING_TASK_PLACEHOLDER_ERROR,
  TASK_PLACEHOLDER,
  tokenizeCommand,
} from "@/eval/run/commandLine.js";
import { parseAgency } from "@/parser.js";

/**
 * How an agent target string is parsed and resolved. A target names an agent
 * entry point: `path`, `path:node`, or a directory (meaning its main.agency).
 * Consumed by the eval commands, the optimizer, and `agency test`.
 */

export function parseTarget(target: string): {
  filename: string;
  nodeName: string;
} {
  const colonIndex = target.lastIndexOf(":");
  if (colonIndex === -1) {
    return { filename: target, nodeName: "" };
  }
  const filename = target.slice(0, colonIndex);
  const nodeName = target.slice(colonIndex + 1);
  return { filename, nodeName };
}

/** Resolve a target into the agent file, node (default "main"), and the
 *  display label run results carry. */
export function resolveEvalRunTarget(target: string): {
  agentFile: string;
  node: string;
  label: string;
} {
  const parsed = parseTarget(target);
  const resolved = path.resolve(parsed.filename);
  const agentFile =
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? path.join(resolved, "main.agency")
      : resolved;
  const node = parsed.nodeName || "main";
  return { agentFile, node, label: `${agentFile}:${node}` };
}

/** What runs as the agent, and what evidence it produces. `file` is the
 *  classic seeded-and-compiled .agency target; `command` is a CLI run in the
 *  workdir (Agency CLIs only — the statelog is the evidence contract). A
 *  future non-Agency variant would be a third kind with a weaker record. */
export type EvalTarget =
  | { kind: "file"; agentFile: string; node: string; label: string }
  | { kind: "command"; tokens: string[]; label: string };

/** Resolve the runner-side agent choice. Exactly one of --agent /
 *  --agent-cmd; the command's {task} placeholder is validated here, before
 *  any run. Commands come ONLY from these flags, never from suite content —
 *  suites can be remote git sources, and a suite that named its own command
 *  would be remote code execution. */
export function resolveEvalTarget(opts: { agent?: string; agentCmd?: string }): EvalTarget {
  if ((opts.agent ? 1 : 0) + (opts.agentCmd ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of an agent file or --agent-cmd");
  }
  if (opts.agentCmd) {
    return { kind: "command", tokens: tokenizeCommand(opts.agentCmd), label: opts.agentCmd };
  }
  return { kind: "file", ...resolveEvalRunTarget(opts.agent as string) };
}

/**
 * Fail fast when the agent's shape does not match what the tests deliver.
 * A test's input reaches a file agent as the entry node's single positional
 * parameter and a command agent as `{task}`; a test with no input reaches a
 * node that takes none / a command with no placeholder. Within one suite the
 * tests must agree (all carry an input, or none does), so the agent has one
 * shape to be. Checked before any workdir is seeded or agent compiled: a
 * mis-shaped agent is a configuration error, not a per-test run failure —
 * and the optimizer would pay it once per candidate. The subprocess
 * bootstrap re-checks the file case at run time (resolveNodeCallArgs).
 *
 * The file check is best-effort: an unreadable or unparseable file, or a
 * node defined elsewhere than the entry file, is left for compile/run to
 * report with better errors than a pre-parse could.
 */
export function assertTargetMatchesInputs(target: EvalTarget, tests: { input?: unknown }[]): void {
  const withInput = tests.filter((test) => test.input !== undefined).length;
  if (withInput !== 0 && withInput !== tests.length) {
    throw new Error(
      `Within one suite either every test provides an "input" or none does; ${withInput} of ${tests.length} do.`,
    );
  }
  const hasInput = withInput > 0;
  if (target.kind === "command") {
    const hasPlaceholder = target.tokens.some((t) => t.includes(TASK_PLACEHOLDER));
    if (hasInput && !hasPlaceholder) throw new Error(MISSING_TASK_PLACEHOLDER_ERROR);
    if (!hasInput && hasPlaceholder) {
      throw new Error(
        `--agent-cmd contains ${TASK_PLACEHOLDER} but no test provides an input — pass --input <text> ` +
          `(or give the tests an "input"), or drop the placeholder for an agent that takes none.`,
      );
    }
    return;
  }
  const count = entryNodeParameterCount(target.agentFile, target.node);
  if (count === undefined) return;
  const { names } = count;
  if (hasInput && names.length !== 1) {
    const detail =
      names.length === 0
        ? `takes none — add one (it may go unused: \`node ${target.node}(task: string) { ... }\`), or drop the input if the agent needs none`
        : `takes ${names.length} (${names.join(", ")}) — add a one-parameter adapter node`;
    throw new Error(
      `eval delivers each test's input as the entry node's single parameter, ` +
        `but node "${target.node}" in ${target.agentFile} ${detail}.`,
    );
  }
  if (!hasInput && names.length !== 0) {
    throw new Error(
      `node "${target.node}" in ${target.agentFile} takes ${names.length} (${names.join(", ")}) ` +
        `but no test provides an input — pass --input <text> (or give the tests an "input"), ` +
        `or make the node take no parameter.`,
    );
  }
}

/** The entry node's parameter names, or undefined when the file cannot be
 *  read/parsed or does not define the node (best-effort, see above). */
function entryNodeParameterCount(agentFile: string, node: string): { names: string[] } | undefined {
  let source: string;
  try {
    source = fs.readFileSync(agentFile, "utf-8");
  } catch {
    return undefined;
  }
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) return undefined;
  for (const candidate of parsed.result.nodes) {
    if (candidate.type !== "graphNode" || candidate.nodeName !== node) continue;
    return { names: candidate.parameters.map((p) => p.name) };
  }
  return undefined;
}

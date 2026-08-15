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
    throw new Error("Provide exactly one of --agent or --agent-cmd");
  }
  if (opts.agentCmd) {
    const tokens = tokenizeCommand(opts.agentCmd);
    if (!tokens.some((t) => t.includes(TASK_PLACEHOLDER))) {
      throw new Error(MISSING_TASK_PLACEHOLDER_ERROR);
    }
    return { kind: "command", tokens, label: opts.agentCmd };
  }
  return { kind: "file", ...resolveEvalRunTarget(opts.agent as string) };
}

/**
 * Fail fast when the entry node cannot receive a task: eval delivers the
 * input's task as the node's single positional parameter, so the node must
 * take exactly one. The subprocess bootstrap enforces the same rule at run
 * time (resolveNodeCallArgs), but by then a workdir has been seeded and the
 * agent compiled — and the optimizer would pay that once per candidate.
 * A misconfigured agent should cost one error, not a suite of run failures.
 *
 * Best-effort: an unreadable or unparseable file, or a node defined
 * elsewhere than the entry file, is left for compile/run to report with
 * better errors than a pre-parse could.
 */
export function assertEvalEntryNodeTakesOneParameter(agentFile: string, node: string): void {
  let source: string;
  try {
    source = fs.readFileSync(agentFile, "utf-8");
  } catch {
    return;
  }
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) return;
  for (const candidate of parsed.result.nodes) {
    if (candidate.type !== "graphNode" || candidate.nodeName !== node) continue;
    const count = candidate.parameters.length;
    if (count !== 1) {
      const detail =
        count === 0
          ? `takes none — add one (it may go unused: \`node ${node}(task: string) { ... }\`)`
          : `takes ${count} (${candidate.parameters.map((p) => p.name).join(", ")}) — add a one-parameter adapter node`;
      throw new Error(
        `eval delivers the input's task as the entry node's single parameter, ` +
          `but node "${node}" in ${agentFile} ${detail}.`,
      );
    }
  }
}

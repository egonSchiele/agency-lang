import * as fs from "fs";
import * as path from "path";

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
      const detail = count === 0
        ? `takes none — add one (it may go unused: \`node ${node}(task: string) { ... }\`)`
        : `takes ${count} (${candidate.parameters.map((p) => p.name).join(", ")}) — add a one-parameter adapter node`;
      throw new Error(
        `eval delivers the input's task as the entry node's single parameter, ` +
        `but node "${node}" in ${agentFile} ${detail}.`,
      );
    }
  }
}

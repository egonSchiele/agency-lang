/**
 * `agency explain-init <entry.agency>` — print a human-readable
 * summary of which top-level declarations and bare statements run at
 * each initialization phase, the cross-variable dep graph the
 * compiler builds, and any cyclic file-level imports detected in the
 * closure.
 *
 * Pure analysis: loads + parses + builds the dep graph + topsort, but
 * does NOT execute any user code. Safe to run against agents that
 * make network calls or modify disk on startup.
 *
 * Implementation reuses {@link buildCompiledClosure} so the output is
 * always consistent with what the compiler / runtime sees. If the
 * closure fails to build (parse error, init cycle, static-references-
 * global), the underlying `CompileClosureError` is propagated to the
 * caller — the CLI wrapper in `scripts/agency.ts` converts that into
 * stderr + exit 1, matching every other compile-time command.
 */

import * as path from "path";
import { AgencyConfig } from "../config.js";
import {
  buildCompiledClosure,
  getAgencyImportTargets,
  type CompiledClosure,
} from "../compiler/compileClosure.js";

/**
 * Render the explain-init report as a single string. Split from the
 * `console.log` call site so tests can snapshot the text without
 * capturing stdout.
 */
export function renderExplainInit(closure: CompiledClosure): string {
  const lines: string[] = [];
  appendPhase(
    lines,
    "Phase A (once per process)",
    closure.staticOrder,
    closure.staticGraph,
  );
  lines.push("");
  appendPhase(
    lines,
    "Phase B (every run)",
    closure.globalOrder,
    closure.globalGraph,
  );
  lines.push("");
  appendDepGraph(lines, closure);
  lines.push("");
  appendImportCycles(lines, closure);
  return lines.join("\n");
}

/**
 * Resolve + build the closure and print the report. Exits via the
 * caller's error-translation path on `CompileClosureError`.
 */
export function explainInit(config: AgencyConfig, entryFile: string): void {
  const closure = buildCompiledClosure(entryFile, config);
  console.log(renderExplainInit(closure));
}

function appendPhase(
  lines: string[],
  title: string,
  order: string[],
  graph: { nodes: Record<string, { moduleId: string; varName: string; loc?: { line?: number } }> },
): void {
  lines.push(`${title}:`);
  if (order.length === 0) {
    lines.push("  (nothing)");
    return;
  }
  for (const key of order) {
    const node = graph.nodes[key];
    if (!node) continue;
    const file = path.basename(node.moduleId);
    // `loc.line` is 0-indexed internally (see docs/dev/locations.md).
    // Convert to 1-indexed for display so CLI output lines up with
    // editor cursor reports and other agency CLI commands.
    const line = node.loc?.line !== undefined ? node.loc.line + 1 : "?";
    const label = node.varName.startsWith("__bareStmt_")
      ? "<bare statement>"
      : node.varName;
    lines.push(`  ${file}:${line}   ${label}`);
  }
}

function appendDepGraph(lines: string[], closure: CompiledClosure): void {
  lines.push("Variable dependency graph:");
  // Iterate static then global in plan order so output is stable.
  const printed: Record<string, true> = {};
  const printOne = (
    key: string,
    graph: { nodes: Record<string, { moduleId: string; varName: string }>; edges: Record<string, string[]> },
  ): void => {
    const node = graph.nodes[key];
    if (!node || printed[key]) return;
    printed[key] = true;
    const deps = (graph.edges[key] ?? []).filter((d) => graph.nodes[d]);
    if (deps.length === 0) {
      lines.push(`  ${displayKey(node)}   (no deps)`);
      return;
    }
    const depLabels = deps.map((d) => displayKey(graph.nodes[d])).join(", ");
    lines.push(`  ${displayKey(node)}   depends on: ${depLabels}`);
  };
  for (const key of closure.staticOrder) printOne(key, closure.staticGraph);
  for (const key of closure.globalOrder) printOne(key, closure.globalGraph);
  if (Object.keys(printed).length === 0) {
    lines.push("  (no top-level variables)");
  }
}

function displayKey(node: { moduleId: string; varName: string }): string {
  const moduleName = path.basename(node.moduleId, ".agency");
  const label = node.varName.startsWith("__bareStmt_")
    ? "<bare statement>"
    : node.varName;
  return `${moduleName}.${label}`;
}

/**
 * Find strongly-connected components of size > 1 in the file-level
 * import graph and print each as a cycle. Tarjan's algorithm; iterative
 * to avoid blowing the JS stack on big closures.
 */
function appendImportCycles(lines: string[], closure: CompiledClosure): void {
  const ids = Object.keys(closure.programs);
  const adj: Record<string, string[]> = {};
  for (const id of ids) {
    adj[id] = getAgencyImportTargets(closure.programs[id], id).filter(
      (target) => closure.programs[target],
    );
  }
  const sccs = tarjanSCC(ids, adj).filter((c) => c.length > 1);
  if (sccs.length === 0) {
    lines.push("Cyclic imports detected (allowed): none");
    return;
  }
  lines.push("Cyclic imports detected (allowed):");
  for (const scc of sccs) {
    const names = scc
      .map((id) => path.basename(id))
      .sort()
      .join(" ⇄ ");
    lines.push(`  ${names}`);
  }
}

/**
 * Iterative Tarjan SCC. Returns each SCC as an array of node ids.
 */
function tarjanSCC(
  nodes: string[],
  adj: Record<string, string[]>,
): string[][] {
  const index: Record<string, number> = {};
  const lowlink: Record<string, number> = {};
  const onStack: Record<string, true> = {};
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  type Frame = { node: string; iter: number };
  const work: Frame[] = [];

  for (const start of nodes) {
    if (index[start] !== undefined) continue;
    work.push({ node: start, iter: 0 });
    index[start] = counter;
    lowlink[start] = counter;
    counter++;
    stack.push(start);
    onStack[start] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const succs = adj[frame.node] ?? [];
      if (frame.iter < succs.length) {
        const w = succs[frame.iter];
        frame.iter++;
        if (index[w] === undefined) {
          index[w] = counter;
          lowlink[w] = counter;
          counter++;
          stack.push(w);
          onStack[w] = true;
          work.push({ node: w, iter: 0 });
        } else if (onStack[w]) {
          lowlink[frame.node] = Math.min(lowlink[frame.node], index[w]);
        }
      } else {
        // Children exhausted: propagate lowlink to caller, finalize SCC.
        if (lowlink[frame.node] === index[frame.node]) {
          const scc: string[] = [];
          while (true) {
            const w = stack.pop()!;
            delete onStack[w];
            scc.push(w);
            if (w === frame.node) break;
          }
          result.push(scc);
        }
        work.pop();
        const parent = work[work.length - 1];
        if (parent) {
          lowlink[parent.node] = Math.min(
            lowlink[parent.node],
            lowlink[frame.node],
          );
        }
      }
    }
  }
  return result;
}

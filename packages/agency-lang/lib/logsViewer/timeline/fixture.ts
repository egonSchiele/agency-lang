// Test-only builders for TreeNode forests. `at` values are ms offsets from
// an arbitrary epoch (0 = 1970 works; only differences matter). Plus
// benchForest(): the checked-in trimmed real statelog, parsed the same way
// production does — for snapshot tests and properties synthetic fixtures
// cannot fake (subprocess boundaries, admin noise, unclosed spans).
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseStatelogJsonl } from "../parse.js";
import { buildForest } from "../tree.js";
import type { EventEnvelope, TreeNode } from "../types.js";

let autoId = 0;

export function span(label: string, children: TreeNode[], opts: { id?: string } = {}): TreeNode {
  return {
    id: opts.id ?? `s${autoId++}`,
    traceId: "T",
    parentId: null,
    children,
    nodeKind: "span",
    label,
    summary: `${label} summary`,
  };
}

export function leaf(type: string, at: number, data: Record<string, unknown> = {}): TreeNode {
  const event: EventEnvelope = {
    format_version: 1,
    trace_id: "T",
    project_id: "",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: new Date(at).toISOString(), ...data },
  };
  return {
    id: `evt-${autoId++}`,
    traceId: "T",
    parentId: null,
    children: [],
    nodeKind: "event",
    label: type,
    summary: "",
    event,
  };
}

export function trace(children: TreeNode[]): TreeNode {
  return {
    id: "trace-T",
    traceId: "T",
    parentId: null,
    children,
    nodeKind: "trace",
    label: "T",
    summary: "",
  };
}

export function benchForest(): TreeNode[] {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const jsonl = fs.readFileSync(path.join(dir, "fixtures", "bench.jsonl"), "utf8");
  return buildForest(parseStatelogJsonl(jsonl).events);
}

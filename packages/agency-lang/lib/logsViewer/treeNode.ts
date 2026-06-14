import { StatelogParser } from "../statelogParser.js";
import type { StatelogNode, ParseError } from "../statelogParser.js";
import type { EventEnvelope } from "../statelog/wireTypes.js";

// One node in the visible tree. Spans/traces/events come from the model; the
// synthetic kinds (jsonLine/convoLine/rawDataToggle) are generated on the fly
// by render.ts when a leaf is expanded.
export type NodeKind =
  | "trace"
  | "span"
  | "event"
  | "jsonLine"
  | "convoLine"
  | "rawDataToggle";

// Event types the viewer hides from the tree (a VIEW concern — the model keeps
// them). `graph` is a one-shot schema dump emitted at the top of each run.
const HIDDEN_EVENT_TYPES = new Set<string>(["graph"]);

type TreeNodeInit = {
  id: string;
  traceId: string;
  parentId: string | null;
  nodeKind: NodeKind;
  label?: string;
  summary?: string;
  duration?: number;
  tokens?: number;
  cost?: number;
  firstTs?: number;
  lineNo?: number;
  children?: TreeNode[];
  parser?: StatelogParser;
  source?: TreeNode;
};

export class TreeNode {
  id: string;
  traceId: string;
  parentId: string | null;
  children: TreeNode[];
  nodeKind: NodeKind;
  label: string;
  // Pre-computed display summary, e.g. `llmCall (1.2s, 1500 tok, $0.007)`.
  summary: string;
  // Rolled up for spans/traces; from the event for leaves.
  duration?: number;
  tokens?: number;
  cost?: number;
  firstTs?: number;
  // Events only — identifies the payload to fetch via the hidden parser.
  lineNo?: number;
  // Hidden model handle. Powers event()/parseErrors(); the parser is an
  // implementation detail of how the tree was built. Absent on synthetic rows;
  // `source` lets a rawDataToggle delegate event() back to its leaf.
  private parser?: StatelogParser;
  private source?: TreeNode;

  constructor(init: TreeNodeInit) {
    this.id = init.id;
    this.traceId = init.traceId;
    this.parentId = init.parentId;
    this.nodeKind = init.nodeKind;
    this.label = init.label ?? "";
    this.summary = init.summary ?? "";
    this.duration = init.duration;
    this.tokens = init.tokens;
    this.cost = init.cost;
    this.firstTs = init.firstTs;
    this.lineNo = init.lineNo;
    this.children = init.children ?? [];
    this.parser = init.parser;
    this.source = init.source;
  }

  // ── public entry points (parser hidden) ──────────────────────────────────
  static forestFromLog(path: string): TreeNode[] {
    return TreeNode.forestFrom(StatelogParser.fromFile(path));
  }

  static forestFromString(jsonl: string): TreeNode[] {
    return TreeNode.forestFrom(StatelogParser.fromString(jsonl));
  }

  private static forestFrom(parser: StatelogParser): TreeNode[] {
    return parser.traces().map((t) => TreeNode.fromModel(t.root(), parser));
  }

  private static fromModel(node: StatelogNode, parser: StatelogParser): TreeNode {
    const tn = new TreeNode({
      id: node.id,
      traceId: node.traceId,
      parentId: node.parentId,
      nodeKind: node.kind,
      label: node.label,
      summary: node.summary,
      duration: node.metrics?.durationMs,
      tokens: node.metrics?.tokens,
      cost: node.metrics?.cost,
      firstTs: node.metrics?.firstTs,
      lineNo: node.lineNo,
      parser,
    });
    tn.children = node.children
      .filter((c) => !(c.kind === "event" && HIDDEN_EVENT_TYPES.has(c.label)))
      .map((c) => TreeNode.fromModel(c, parser));
    return tn;
  }

  // ── synthetic view rows (no model payload of their own) ───────────────────
  static syntheticLine(
    parent: TreeNode,
    id: string,
    nodeKind: NodeKind,
    summary: string,
  ): TreeNode {
    return new TreeNode({ id, traceId: parent.traceId, parentId: parent.id, nodeKind, summary });
  }

  // The "raw data" toggle delegates event() back to the leaf it was spawned
  // from, so its JSON rows can be regenerated without holding a payload.
  static rawDataToggle(leaf: TreeNode): TreeNode {
    return new TreeNode({
      id: `${leaf.id}:raw`,
      traceId: leaf.traceId,
      parentId: leaf.id,
      nodeKind: "rawDataToggle",
      label: "raw data",
      summary: "raw data",
      source: leaf,
    });
  }

  // ── lazy model access (parser stays hidden) ───────────────────────────────
  event(): EventEnvelope | undefined {
    if (this.source) return this.source.event();
    return this.parser?.eventOf(this.id);
  }

  parseErrors(): ParseError[] {
    return this.parser?.parseErrors() ?? [];
  }
}

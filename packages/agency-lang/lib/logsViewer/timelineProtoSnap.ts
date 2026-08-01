// PROTOTYPE — THROWAWAY. Headless snapshot of the timeline prototype:
// prints both views of a statelog as plain text, for eyeballing without
// a TTY. Run: npx tsx lib/logsViewer/timelineProtoSnap.ts <statelog.jsonl>
import * as fs from "fs";

import { parseStatelogJsonl } from "./parse.js";
import { buildForest } from "./tree.js";
import { enterProto, renderProto, protoHandleKey, type ProtoState } from "./timelineProto.js";
import type { Element } from "../tui/elements.js";
import type { ViewerState } from "./types.js";

const path = process.argv[2];
const cols = Number(process.argv[3] ?? 110);
const parsed = parseStatelogJsonl(fs.readFileSync(path, "utf8"));
const roots = buildForest(parsed.events);
const state = { roots, cursorId: roots[0].id, expanded: new Set() } as unknown as ViewerState;

let proto = enterProto(state);
if (!proto) throw new Error("no spans");

const flatten = (el: Element): string[] => {
  if (el.type === "text") return [el.content ?? ""];
  return (el.children ?? []).flatMap(flatten);
};

const show = (p: ProtoState, title: string) => {
  console.log(`\n═══ ${title} ═══`);
  for (const l of flatten(renderProto(p, { rows: 34, cols }))) console.log(l);
};

show(proto, "flame view (top level)");

// drill into the longest top-level-ish span: move cursor to the deepest
// big thing — here just walk down a few rows and drill twice
const longest = proto.spans
  .map((s, i) => ({ i, dur: s.end - s.start, depth: s.depth }))
  .filter((x) => x.depth <= 2)
  .sort((a, b) => b.dur - a.dur)[0];
proto = { ...proto, cursor: longest?.i ?? 0 };
proto = protoHandleKey(proto, { key: "enter" });
show(proto, "flame view, drilled into the longest span (Enter)");

proto = protoHandleKey(proto, { key: "t" });
show(proto, "byName view of the drilled subtree");

// occurrences of the 3rd-busiest name (usually a tool like bash)
proto = { ...proto, cursor: Math.min(2, proto.byName.length - 1) };
proto = protoHandleKey(proto, { key: "enter" });
show(proto, "occurrences view (Enter on a byName row)");

// detail of the 2nd occurrence
proto = protoHandleKey(proto, { key: "down" });
proto = protoHandleKey(proto, { key: "d" });
show(proto, "detail screen (d on an occurrence)");

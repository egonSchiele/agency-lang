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

show(proto, "flame view");
proto = protoHandleKey(proto, { key: "t" });
show(proto, "byName view");
proto = protoHandleKey(proto, { key: "+" });
show(proto, "byName, zoomed 2x around selection");

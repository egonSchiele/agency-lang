import * as fs from "fs";
import * as path from "path";
import * as ohm from "ohm-js";
import { createSemantics } from "./semantics.js";
import type { AgencyNode } from "@/types.js";

const grammarPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "agency.ohm",
);
const grammarSource = fs.readFileSync(grammarPath, "utf-8");
const grammar = ohm.grammar(grammarSource);
const semantics = grammar.createSemantics();
createSemantics(semantics);

export function parseWithOhm(input: string): AgencyNode {
  const match = grammar.match(input);
  if (match.failed()) {
    throw new Error(`Parse failed: ${match.message}`);
  }
  return semantics(match).toAST();
}

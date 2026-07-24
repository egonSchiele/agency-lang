import { BaseNode } from "./base.js";
import type { AgencyNode } from "../types.js";

/** An inline template: `[| ... |]`. The body is PARSED at parse time of
 *  the enclosing file (unlowered template mode, holes intact) and stored
 *  as real nodes — that is what lets the formatter reformat bodies and
 *  makes a malformed template a compile error. The node is a host-side
 *  LEAF: quoted names belong to the generated program, not the host
 *  scope (see the leaf-ness levers in docs/dev/template-agency.md). */
export type CodeLiteral = BaseNode & {
  type: "codeLiteral";
  nodes: AgencyNode[];
  kind: "expr" | "statements" | "program";
};

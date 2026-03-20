import { $, ts } from "./builders.js";
import type { TsNode } from "./tsIR.js";
import { printTs } from "./prettyPrint.js";
import type { AuditEntry } from "../runtime/audit.js";

/** Maps each AuditEntry variant's fields (minus type/timestamp) to TsNode values */
type AuditFieldsOf<T extends AuditEntry["type"]> = {
  [K in keyof Omit<Extract<AuditEntry, { type: T }>, "type" | "timestamp">]: TsNode;
};

/**
 * Inspects a processed TsNode and returns a TsNode that represents
 * an `await __ctx.audit(...)` call, or null if this node should not be audited.
 *
 * For return/functionReturn nodes, returns a TsStatements containing
 * [auditCall, originalNode] since the audit must run before the return.
 */
type Behavior = "append" | "replace";

function append(node: TsNode): { node: TsNode; behavior: "append" } {
  return { node, behavior: "append" };
}

function replace(node: TsNode): { node: TsNode; behavior: "replace" } {
  return { node, behavior: "replace" };
}

export function auditNode(
  node: TsNode,
): { node: TsNode; behavior: Behavior } | null {
  switch (node.kind) {
    case "assign":
      // For destructuring assignments like [x, y] = await Promise.all([x, y]),
      // emit one assignment audit per variable
      if (node.lhs.kind === "arrayLiteral") {
        const audits = node.lhs.items.map((item) =>
          makeAuditCall("assignment", {
            variable: ts.str(printTs(item)),
            value: item,
          }),
        );
        return audits.length === 1
          ? append(audits[0])
          : append(ts.statements(audits));
      }
      return append(
        makeAuditCall("assignment", {
          variable: ts.str(printTs(node.lhs)),
          value: node.lhs,
        }),
      );

    case "varDecl":
      return append(
        makeAuditCall("assignment", {
          variable: ts.str(node.name),
          value: ts.id(node.name),
        }),
      );

    case "call":
      return append(
        makeAuditCall("functionCall", {
          functionName: ts.str(printTs(node.callee)),
          args: ts.arr(node.arguments),
          result: ts.id("undefined"),
        }),
      );

    case "return":
      if (node.expr) {
        const audit = makeAuditCall("return", { value: node.expr });
        return replace(ts.statements([audit, node]));
      }
      return replace(
        ts.statements([
          makeAuditCall("return", { value: ts.id("undefined") }),
          node,
        ]),
      );

    case "functionReturn": {
      const audit = makeAuditCall("return", { value: node.value });
      return replace(ts.statements([audit, node]));
    }

    case "await":
      return auditNode(node.expr);

    case "statements":
      for (const child of node.body) {
        const result = auditNode(child);
        if (result) return result;
      }
      return null;

    default:
      return null;
  }
}

function makeAuditCall<T extends AuditEntry["type"]>(type: T, fields: AuditFieldsOf<T>): TsNode {
  return $(ts.runtime.ctx)
    .prop("audit")
    .call([ts.obj({ type: ts.str(type), ...fields })])
    .await()
    .done();
}

import { $, ts } from "./builders.js";
import type { TsNode } from "./tsIR.js";
import { printTs } from "./prettyPrint.js";

/**
 * Inspects a processed TsNode and returns a TsNode that represents
 * an `await __ctx.audit(...)` call, or null if this node should not be audited.
 *
 * For return/functionReturn nodes, returns a TsStatements containing
 * [auditCall, originalNode] since the audit must run before the return.
 */
export function auditNode(node: TsNode): TsNode | null {
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
        return audits.length === 1 ? audits[0] : ts.statements(audits);
      }
      return makeAuditCall("assignment", {
        variable: ts.str(printTs(node.lhs)),
        value: node.lhs,
      });

    case "varDecl":
      return makeAuditCall("assignment", {
        variable: ts.str(node.name),
        value: ts.id(node.name),
      });

    case "call":
      return makeAuditCall("functionCall", {
        functionName: ts.str(printTs(node.callee)),
        args: ts.arr(node.arguments),
      });

    case "return":
      if (node.expr) {
        const audit = makeAuditCall("return", { value: node.expr });
        return ts.statements([audit, node]);
      }
      return ts.statements([
        makeAuditCall("return", { value: ts.id("undefined") }),
        node,
      ]);

    case "functionReturn": {
      const audit = makeAuditCall("return", { value: node.value });
      return ts.statements([audit, node]);
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

function makeAuditCall(type: string, fields: Record<string, TsNode>): TsNode {
  return $(ts.runtime.ctx)
    .prop("audit")
    .call([ts.obj({ type: ts.str(type), ...fields })])
    .await()
    .done();
}

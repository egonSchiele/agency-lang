import { AgencyNode } from "@/types.js";

export function* getAllVariablesInBody(
  body: AgencyNode[],
): Generator<{ name: string; node: AgencyNode }> {
  for (const { node } of walkNodes(body)) {
    if (node.type === "assignment") {
      yield { name: node.variableName, node };
      yield* getAllVariablesInBody([node.value as AgencyNode]);
    } else if (node.type === "function") {
      yield { name: node.functionName, node };
      for (const param of node.parameters) {
        yield { name: param.name, node };
      }
      yield* getAllVariablesInBody(node.body);
    } else if (node.type === "graphNode") {
      yield { name: node.nodeName, node };
      for (const param of node.parameters) {
        yield { name: param.name, node };
      }
      yield* getAllVariablesInBody(node.body);
    } else if (node.type === "ifElse") {
      yield* getAllVariablesInBody([node.condition]);
      yield* getAllVariablesInBody(node.thenBody);
      if (node.elseBody) {
        yield* getAllVariablesInBody(node.elseBody);
      }
    } else if (node.type === "functionCall") {
      for (const arg of node.arguments) {
        yield* getAllVariablesInBody([arg]);
      }
      yield { name: node.functionName, node };
    } else if (node.type === "specialVar") {
      yield { name: node.name, node };
    } else if (node.type === "importStatement") {
      yield { name: node.importedNames, node };
    } else if (node.type === "importNodeStatement") {
      for (const name of node.importedNodes) {
        yield { name, node };
      }
    } else if (node.type === "importToolStatement") {
      for (const name of node.importedTools) {
        yield { name, node };
      }
    } else if (node.type === "matchBlock") {
      for (const caseItem of node.cases) {
        if (caseItem.type === "comment") continue;
        if (caseItem.caseValue === "_") continue;
        yield* getAllVariablesInBody([caseItem.caseValue]);
      }
    } else if (node.type === "variableName") {
      yield { name: node.value, node };
    } else if (node.type === "indexAccess") {
      if (node.array.type === "variableName") {
        yield { name: node.array.value, node: node.array };
      }
      if (node.index.type === "variableName") {
        yield { name: node.index.value, node: node.index };
      }
    } else if (node.type === "dotProperty") {
      if (node.object.type === "variableName") {
        yield { name: node.object.value, node: node.object };
      }
    } else if (node.type === "accessExpression") {
      if (node.expression.type === "dotFunctionCall") {
        if (node.expression.object.type === "variableName") {
          yield {
            name: node.expression.object.value,
            node: node.expression.object,
          };
        }
      } else if (node.expression.type === "dotProperty") {
        yield* getAllVariablesInBody([node.expression.object]);
      }
    } else if (node.type === "agencyArray") {
      for (const item of node.items) {
        yield* getAllVariablesInBody([item]);
      }
    } else if (node.type === "agencyObject") {
      for (const entry of node.entries) {
        yield* getAllVariablesInBody([entry.value]);
      }
    } else if (
      node.type === "prompt" ||
      node.type === "string" ||
      node.type === "multiLineString"
    ) {
      for (const seg of node.segments) {
        if (seg.type === "interpolation") {
          yield { name: seg.variableName, node };
        }
      }
      if (node.type === "prompt") {
        for (const toolName of node.tools?.toolNames ?? []) {
          yield { name: toolName, node };
        }
      }
    } else if (node.type === "returnStatement") {
      yield* getAllVariablesInBody([node.value]);
    } else if (node.type === "whileLoop") {
      yield* getAllVariablesInBody(node.body);
    } else if (node.type === "timeBlock") {
      yield* getAllVariablesInBody(node.body);
    } else if (node.type === "messageThread") {
      yield* getAllVariablesInBody(node.body);
    }
  }
}

export function getNodesOfType<T extends AgencyNode["type"]>(
  nodes: AgencyNode[],
  type: T,
): AgencyNode[] {
  const result: AgencyNode[] = [];
  for (const { node } of walkNodes(nodes)) {
    if (node.type === type) {
      result.push(node);
    }
  }
  return result;
}

export function* walkNodes(
  nodes: AgencyNode[],
  ancestors: AgencyNode[] = [],
): Generator<{ node: AgencyNode; ancestors: AgencyNode[] }> {
  for (const node of nodes) {
    yield { node, ancestors };
    if (node.type === "function") {
      yield* walkNodes(node.body, [...ancestors, node]);
    } else if (node.type === "graphNode") {
      yield* walkNodes(node.body, [...ancestors, node]);
    } else if (node.type === "ifElse") {

      yield* walkNodes([node.condition], [...ancestors, node]);
      yield* walkNodes(node.thenBody, [...ancestors, node]);
      if (node.elseBody) {
        yield* walkNodes(node.elseBody, [...ancestors, node]);
      }
    } else if (node.type === "whileLoop") {
      yield* walkNodes([node.condition], [...ancestors, node]);
      yield* walkNodes(node.body, [...ancestors, node]);
    } else if (node.type === "timeBlock") {
      yield* walkNodes(node.body, [...ancestors, node]);
    } else if (node.type === "messageThread") {
      yield* walkNodes(node.body, [...ancestors, node]);
    } else if (node.type === "returnStatement") {
      yield* walkNodes([node.value], [...ancestors, node]);
    } else if (node.type === "assignment") {
      yield* walkNodes([node.value], [...ancestors, node]);
    } else if (node.type === "functionCall") {
      yield* walkNodes(node.arguments, [...ancestors, node]);
    } else if (node.type === "matchBlock") {
      for (const caseItem of node.cases) {
        if (caseItem.type === "comment") continue;
        if (caseItem.caseValue !== "_") {
          yield* walkNodes([caseItem.caseValue], [...ancestors, node]);
        }
        yield* walkNodes([caseItem.body], [...ancestors, node]);
      }
    } else if (node.type === "accessExpression") {
      const expr = node.expression;
      if (expr.type === "dotProperty") {
        yield* walkNodes([expr.object], [...ancestors, node]);
      } else if (expr.type === "indexAccess") {
        yield* walkNodes([expr.array], [...ancestors, node]);
        yield* walkNodes([expr.index], [...ancestors, node]);
      } else if (expr.type === "dotFunctionCall") {
        yield* walkNodes([expr.object], [...ancestors, node]);
        yield* walkNodes([expr.functionCall], [...ancestors, node]);
      }
    } else if (node.type === "dotProperty") {
      yield* walkNodes([node.object], [...ancestors, node]);
    } else if (node.type === "indexAccess") {
      yield* walkNodes([node.array], [...ancestors, node]);
      yield* walkNodes([node.index], [...ancestors, node]);
    } else if (node.type === "agencyArray") {
      yield* walkNodes(node.items, [...ancestors, node]);
    } else if (node.type === "agencyObject") {
      yield* walkNodes(
        node.entries.map((e) => e.value),
        [...ancestors, node],
      );
    } else if (node.type === "specialVar") {
      yield* walkNodes([node.value], [...ancestors, node]);
    }
  }
}

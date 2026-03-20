import {
  AgencyNode,
  InterpolationSegment,
  ValueAccess,
  VariableNameLiteral,
  functionScope,
  getImportedNames,
  globalScope,
  nodeScope,
  Scope,
} from "@/types.js";
import { color } from "@/utils/termcolors.js";

/**
 * Extract the base variable name from an interpolation segment's expression.
 */
export function getBaseVarName(seg: InterpolationSegment): string {
  if (seg.expression.type === "variableName") {
    return seg.expression.value;
  }
  // ValueAccess — the base should be a VariableNameLiteral
  return (seg.expression.base as VariableNameLiteral).value;
}

/**
 * Render an expression (VariableNameLiteral or ValueAccess) as a string
 * WITHOUT scope prefix. Used for prompt function bodies (where variables
 * are function parameters) and for re-emitting agency source code.
 */
export function expressionToString(
  expr: VariableNameLiteral | ValueAccess,
): string {
  if (expr.type === "variableName") {
    return expr.value;
  }
  // ValueAccess
  let code = expressionToString(expr.base as VariableNameLiteral | ValueAccess);
  for (const element of expr.chain) {
    switch (element.kind) {
      case "property":
        code += `.${element.name}`;
        break;
      case "index":
        code += `[${expressionToString(element.index as VariableNameLiteral | ValueAccess)}]`;
        break;
      case "methodCall": {
        const fc = element.functionCall;
        const args = fc.arguments
          .map((a) =>
            expressionToString(a as VariableNameLiteral | ValueAccess),
          )
          .join(", ");
        code += `.${fc.functionName}(${args})`;
        break;
      }
    }
  }
  return code;
}

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
      for (const nameObj of node.importedNames) {
        for (const name of getImportedNames(nameObj)) {
          yield { name, node };
        }
      }
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
    } else if (node.type === "valueAccess") {
      yield* getAllVariablesInBody([node.base]);
      for (const element of node.chain) {
        if (element.kind === "index") {
          yield* getAllVariablesInBody([element.index]);
        } else if (element.kind === "methodCall") {
          yield* getAllVariablesInBody(element.functionCall.arguments);
        }
      }
    } else if (node.type === "agencyArray") {
      for (const item of node.items) {
        if (item.type === "splat") {
          yield* getAllVariablesInBody([item.value]);
        } else {
          yield* getAllVariablesInBody([item]);
        }
      }
    } else if (node.type === "agencyObject") {
      for (const entry of node.entries) {
        if ("type" in entry && entry.type === "splat") {
          yield* getAllVariablesInBody([entry.value]);
        } else {
          yield* getAllVariablesInBody([(entry as any).value]);
        }
      }
    } else if (
      node.type === "string" ||
      node.type === "multiLineString"
    ) {
      for (const seg of node.segments) {
        if (seg.type === "interpolation") {
          yield* getAllVariablesInBody([seg.expression as AgencyNode]);
        }
      }
    } else if (node.type === "returnStatement") {
      yield* getAllVariablesInBody([node.value]);
    } else if (node.type === "forLoop") {
      yield* getAllVariablesInBody([node.iterable]);
      yield* getAllVariablesInBody(node.body);
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

export let walkNodeDebug = false;
export const setWalkNodeDebug = (value: boolean) => (walkNodeDebug = value);
export function* walkNodes(
  nodes: AgencyNode[],
  ancestors: AgencyNode[] = [],
  scopes: Scope[] = [],
): Generator<{ node: AgencyNode; ancestors: AgencyNode[]; scopes: Scope[] }> {
  if (scopes.length === 0) {
    scopes.push(globalScope());
  }
  for (const node of nodes) {
    if (walkNodeDebug)
      console.log(color.magenta("walkNodes:"), { node, ancestors });
    yield { node, ancestors, scopes };
    if (node.type === "function") {
      yield* walkNodes(
        node.body,
        [...ancestors, node],
        [...scopes, functionScope(node.functionName)],
      );
    } else if (node.type === "graphNode") {
      yield* walkNodes(
        node.body,
        [...ancestors, node],
        [...scopes, nodeScope(node.nodeName)],
      );
    } else if (node.type === "ifElse") {
      yield* walkNodes([node.condition], [...ancestors, node], scopes);
      yield* walkNodes(node.thenBody, [...ancestors, node], scopes);
      if (node.elseBody) {
        yield* walkNodes(node.elseBody, [...ancestors, node], scopes);
      }
    } else if (node.type === "forLoop") {
      yield* walkNodes([node.iterable as AgencyNode], [...ancestors, node], scopes);
      yield* walkNodes(node.body, [...ancestors, node], scopes);
    } else if (node.type === "whileLoop") {
      yield* walkNodes([node.condition], [...ancestors, node], scopes);
      yield* walkNodes(node.body, [...ancestors, node], scopes);
    } else if (node.type === "timeBlock") {
      yield* walkNodes(node.body, [...ancestors, node], scopes);
    } else if (node.type === "messageThread") {
      /* console.log(
        color.green(
          "HI IM IN A FUCKING MESSAGE THRED!",
          JSON.stringify(node.body),
        ),
      ); */
      yield* walkNodes(node.body, [...ancestors, node], scopes);
    } else if (node.type === "returnStatement") {
      yield* walkNodes([node.value], [...ancestors, node], scopes);
    } else if (node.type === "assignment") {
      /* console.log(
        color.red(
          "HI IM IN A FUCKING MESSAGE ARGUMENT!",
          JSON.stringify([node.value]),
        ),
      ); */
      yield* walkNodes([node.value], [...ancestors, node], scopes);
      if (node.accessChain) {
        for (const accessElement of node.accessChain) {
          if (accessElement.kind === "index") {
            yield* walkNodes(
              [accessElement.index],
              [...ancestors, node],
              scopes,
            );
          } else if (accessElement.kind === "methodCall") {
            yield* walkNodes(
              [accessElement.functionCall],
              [...ancestors, node],
              scopes,
            );
          }
        }
      }
    } else if (node.type === "functionCall") {
      yield* walkNodes(node.arguments, [...ancestors, node], scopes);
    } else if (node.type === "matchBlock") {
      yield* walkNodes([node.expression], [...ancestors, node], scopes);
      for (const caseItem of node.cases) {
        if (caseItem.type === "comment") continue;
        if (caseItem.caseValue !== "_") {
          yield* walkNodes([caseItem.caseValue], [...ancestors, node], scopes);
        }
        yield* walkNodes([caseItem.body], [...ancestors, node], scopes);
      }
    } else if (node.type === "valueAccess") {
      yield* walkNodes([node.base], [...ancestors, node], scopes);
      for (const element of node.chain) {
        if (element.kind === "index") {
          yield* walkNodes([element.index], [...ancestors, node], scopes);
        } else if (element.kind === "methodCall") {
          yield* walkNodes(
            [element.functionCall],
            [...ancestors, node],
            scopes,
          );
        }
      }
    } else if (node.type === "agencyArray") {
      const arrayItems = node.items.map((item) =>
        item.type === "splat" ? item.value : item,
      );
      yield* walkNodes(
        arrayItems as AgencyNode[],
        [...ancestors, node],
        scopes,
      );
    } else if (node.type === "agencyObject") {
      const objValues = node.entries.map((e) =>
        "type" in e && e.type === "splat" ? e.value : (e as any).value,
      );
      yield* walkNodes(objValues as AgencyNode[], [...ancestors, node], scopes);
    } else if (node.type === "specialVar") {
      yield* walkNodes([node.value], [...ancestors, node], scopes);
    } else if (
      node.type === "string" ||
      node.type === "multiLineString"
    ) {
      for (const seg of node.segments) {
        if (seg.type === "interpolation") {
          yield* walkNodes(
            [seg.expression as AgencyNode],
            [...ancestors, node],
            scopes,
          );
        }
      }
    } else if (node.type === "binOpExpression") {
      yield* walkNodes([node.left], [...ancestors, node], scopes);
      yield* walkNodes([node.right], [...ancestors, node], scopes);
    }
  }
}

export function walkNodesArray(
  nodes: AgencyNode[],
  ancestors: AgencyNode[] = [],
  scopes: Scope[] = [],
) {
  const results: {
    node: AgencyNode;
    ancestors: AgencyNode[];
    scopes: Scope[];
  }[] = [];
  for (const result of walkNodes(nodes, ancestors, scopes)) {
    results.push(result);
  }
  return results;
}

export function getAllVariablesInBodyArray(body: AgencyNode[]) {
  const results: { name: string; node: AgencyNode }[] = [];
  for (const result of getAllVariablesInBody(body)) {
    results.push(result);
  }
  return results;
}

import {
  AgencyNode,
  Expression,
  InterpolationSegment,
  NamedArgument,
  SplatExpression,
  ValueAccess,
  VariableNameLiteral,
  functionScope,
  getImportedNames,
  globalScope,
  nodeScope,
  Scope,
} from "@/types.js";
import { color } from "@/utils/termcolors.js";

/** Unwrap a function call argument to its inner expression. */
function unwrapCallArg(arg: Expression | SplatExpression | NamedArgument): Expression {
  if (arg.type === "splat") {
    return arg.value;
  }
  if (arg.type === "namedArgument") {
    return arg.value;
  }
  return arg;
}

/** Convert a function call argument to string. */
function callArgToString(arg: Expression | SplatExpression | NamedArgument): string {
  if (arg.type === "splat") {
    return `...${expressionToString(arg.value)}`;
  }
  if (arg.type === "namedArgument") {
    return `${arg.name}: ${expressionToString(arg.value)}`;
  }
  return expressionToString(arg);
}

/**
 * Extract the base variable name from an interpolation segment's expression.
 * Returns the variable name if the expression is a simple variable or the base
 * of a value access chain. For other expression types, returns an empty string.
 */
export function getBaseVarName(seg: InterpolationSegment): string {
  if (seg.expression.type === "variableName") {
    return seg.expression.value;
  }
  if (seg.expression.type === "valueAccess") {
    return (seg.expression.base as VariableNameLiteral).value;
  }
  return "";
}

/**
 * Render an expression as a string WITHOUT scope prefix.
 * Used for prompt function bodies (where variables are function parameters)
 * and for re-emitting agency source code.
 */
export function expressionToString(expr: Expression): string {
  switch (expr.type) {
    case "variableName":
      return expr.value;
    case "number":
      return expr.value;
    case "boolean":
      return String(expr.value);
    case "null":
      return "null";
    case "string":
    case "multiLineString":
      return expr.segments.map(seg =>
        seg.type === "text" ? seg.value : `\${${expressionToString(seg.expression)}}`
      ).join("");
    case "functionCall": {
      const args = expr.arguments.map(callArgToString).join(", ");
      return `${expr.functionName}(${args})`;
    }
    case "valueAccess": {
      let code = expressionToString(expr.base as Expression);
      for (const element of expr.chain) {
        switch (element.kind) {
          case "property":
            code += `.${element.name}`;
            break;
          case "index":
            code += `[${expressionToString(element.index as Expression)}]`;
            break;
          case "methodCall": {
            const fc = element.functionCall;
            const args = fc.arguments.map(callArgToString).join(", ");
            code += `.${fc.functionName}(${args})`;
            break;
          }
        }
      }
      return code;
    }
    case "binOpExpression":
      return `${expressionToString(expr.left)} ${expr.operator} ${expressionToString(expr.right)}`;
    case "agencyArray":
      return `[${expr.items.map(item =>
        item.type === "splat" ? `...${expressionToString(item.value)}` : expressionToString(item)
      ).join(", ")}]`;
    case "agencyObject":
      return `{${expr.entries.map(entry =>
        "type" in entry && entry.type === "splat"
          ? `...${expressionToString(entry.value)}`
          : `${(entry as any).key}: ${expressionToString((entry as any).value)}`
      ).join(", ")}}`;
    case "placeholder":
      return "?";
    case "tryExpression":
      return `try ${expressionToString(expr.call)}`;
    case "newExpression": {
      const args = expr.arguments.map(a => expressionToString(a)).join(", ");
      return `new ${expr.className}(${args})`;
    }
  }
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
        yield* getAllVariablesInBody([unwrapCallArg(arg)]);
      }
      if (node.block) {
        for (const param of node.block.params) {
          yield { name: param.name, node };
        }
        yield* getAllVariablesInBody(node.block.body);
      }
      yield { name: node.functionName, node };
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
      for (const namedImport of node.importedTools) {
        for (const name of namedImport.importedNames) {
          yield { name, node };
        }
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
          for (const arg of element.functionCall.arguments) {
            yield* getAllVariablesInBody([unwrapCallArg(arg)]);
          }
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
    } else if (node.type === "messageThread") {
      yield* getAllVariablesInBody(node.body);
    } else if (node.type === "handleBlock") {
      yield* getAllVariablesInBody(node.body);
      if (node.handler.kind === "inline") {
        yield* getAllVariablesInBody(node.handler.body);
      }
    } else if (node.type === "withModifier") {
      yield* getAllVariablesInBody([node.statement]);
    } else if (node.type === "tryExpression") {
      yield* getAllVariablesInBody([node.call as AgencyNode]);
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
    } else if (node.type === "newExpression") {
      yield* walkNodes(node.arguments as AgencyNode[], [...ancestors, node], scopes);
    } else if (node.type === "classDefinition") {
      for (const field of node.fields) {
        yield { node: field, ancestors: [...ancestors, node], scopes };
      }
      for (const method of node.methods) {
        const methodScopeName = `${node.className}.${method.name}`;
        const methodScopes = [...scopes, functionScope(methodScopeName)];
        yield { node: method, ancestors: [...ancestors, node], scopes: methodScopes };
        yield* walkNodes(method.body, [...ancestors, node, method], methodScopes);
      }
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
    } else if (node.type === "messageThread") {
      yield* walkNodes(node.body, [...ancestors, node], scopes);
    } else if (node.type === "handleBlock") {
      yield* walkNodes(node.body, [...ancestors, node], scopes);
      if (node.handler.kind === "inline") {
        yield* walkNodes(node.handler.body, [...ancestors, node], scopes);
      }
    } else if (node.type === "withModifier") {
      yield* walkNodes([node.statement], [...ancestors, node], scopes);
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
      for (const arg of node.arguments) {
        yield* walkNodes([unwrapCallArg(arg) as AgencyNode], [...ancestors, node], scopes);
      }
      if (node.block) {
        yield* walkNodes(node.block.body, [...ancestors, node], scopes);
      }
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

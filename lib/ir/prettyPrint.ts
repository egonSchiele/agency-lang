import type { TsNode, TsParam, TsScopedVar } from "./tsIR.js";
import * as renderSubstepBlock from "../templates/backends/typescriptGenerator/substepBlock.js";
import * as renderIfStepsCondbranch from "../templates/backends/typescriptGenerator/ifStepsCondbranch.js";
import * as renderIfStepsBranchDispatch from "../templates/backends/typescriptGenerator/ifStepsBranchDispatch.js";
import * as renderThreadSteps from "../templates/backends/typescriptGenerator/threadSteps.js";
import * as renderWhileSteps from "../templates/backends/typescriptGenerator/whileSteps.js";
import * as renderForSteps from "../templates/backends/typescriptGenerator/forSteps.js";

const INDENT = "  ";

function scopeToPrefix(scope: TsScopedVar["scope"]): string {
  switch (scope) {
    case "global":
      throw new Error(
        "Global-scoped variables must have a moduleId on TsScopedVar",
      );
    case "function":
    case "node":
    case "local":
      return "__stack.locals";
    case "args":
      return "__stack.args";
    case "imported":
    case "shared":
      return "";
  }
}

function ind(depth: number): string {
  return INDENT.repeat(depth);
}

function printParam(p: TsParam): string {
  let s = p.name;
  if (p.typeAnnotation) s += `: ${p.typeAnnotation}`;
  if (p.defaultValue) s += ` = ${printTs(p.defaultValue)}`;
  return s;
}

function printParams(params: TsParam[]): string {
  return params.map(printParam).join(", ");
}

export function printTs(node: TsNode, indent = 0): string {
  switch (node.kind) {
    case "raw":
      return node.code;

    case "statements":
      return node.body.map((n) => printTs(n, indent)).join("\n");

    case "import": {
      const from = JSON.stringify(node.from);
      switch (node.importKind) {
        case "default":
          return `import ${node.defaultName} from ${from};`;
        case "namespace":
          return `import * as ${node.namespaceName} from ${from};`;
        case "type":
          return `import type { ${node.names.join(", ")} } from ${from};`;
        case "named":
        default:
          return `import { ${node.names.join(", ")} } from ${from};`;
      }
    }

    case "varDecl": {
      let s = `${node.declKind} ${node.name}`;
      if (node.typeAnnotation) s += `: ${node.typeAnnotation}`;
      if (node.initializer) s += ` = ${printTs(node.initializer, indent)}`;
      return s + ";";
    }

    case "assign":
      return `${printTs(node.lhs, indent)} = ${printTs(node.rhs, indent)};`;

    case "functionDecl": {
      const parts: string[] = [];
      if (node.export) parts.push("export");
      if (node.async) parts.push("async");
      parts.push("function");
      parts.push(node.name);
      const sig = `${parts.join(" ")}(${printParams(node.params)})`;
      const ret = node.returnType ? `: ${node.returnType}` : "";
      const body = printBody(node.body, indent);
      return `${sig}${ret} {\n${body}\n${ind(indent)}}`;
    }

    case "arrowFn": {
      const prefix = node.async ? "async " : "";
      const params = `(${printParams(node.params)})`;
      const ret = node.returnType ? `: ${node.returnType}` : "";
      if (node.body.kind === "statements") {
        const body = printBody(node.body, indent);
        return `${prefix}${params}${ret} => {\n${body}\n${ind(indent)}}`;
      }
      return `${prefix}${params}${ret} => ${printTs(node.body, indent)}`;
    }

    case "call": {
      const callee = printTs(node.callee, indent);
      const args = node.arguments.map((a) => printTs(a, indent)).join(", ");
      return `${callee}(${args})`;
    }

    case "await":
      return `await ${printTs(node.expr, indent)}`;

    case "return":
      return node.expr ? `return ${printTs(node.expr, indent)};` : "return;";

    case "objectLiteral": {
      if (node.entries.length === 0) return "{}";
      const inner = node.entries.map((e) => {
        if (e.spread)
          return `${ind(indent + 1)}...${printTs(e.expr, indent + 1)}`;
        return `${ind(indent + 1)}${e.key}: ${printTs(e.value, indent + 1)}`;
      });
      return `{\n${inner.join(",\n")}\n${ind(indent)}}`;
    }

    case "arrayLiteral": {
      if (node.items.length === 0) return "[]";
      const items = node.items.map((i) => printTs(i, indent)).join(", ");
      return `[${items}]`;
    }

    case "templateLit": {
      let s = "`";
      for (const part of node.parts) {
        s += part.text.replace(/`/g, "\\`");
        if (part.expr) s += `\${${printTs(part.expr, indent)}}`;
      }
      s += "`";
      return s;
    }

    case "if": {
      let s = `if (${printTs(node.condition, indent)}) {\n${printBody(node.body, indent)}\n${ind(indent)}}`;
      for (const ei of node.elseIfs) {
        s += ` else if (${printTs(ei.condition, indent)}) {\n${printBody(ei.body, indent)}\n${ind(indent)}}`;
      }
      if (node.elseBody) {
        s += ` else {\n${printBody(node.elseBody, indent)}\n${ind(indent)}}`;
      }
      return s;
    }

    case "for": {
      if (node.variant === "of") {
        return `for (const ${node.varName} of ${printTs(node.iterable!, indent)}) {\n${printBody(node.body, indent)}\n${ind(indent)}}`;
      }
      const init = printTs(node.init!, indent).replace(/;$/, "");
      const cond = printTs(node.condition!, indent);
      const update = printTs(node.update!, indent).replace(/;$/, "");
      return `for (${init}; ${cond}; ${update}) {\n${printBody(node.body, indent)}\n${ind(indent)}}`;
    }

    case "while":
      return `while (${printTs(node.condition, indent)}) {\n${printBody(node.body, indent)}\n${ind(indent)}}`;

    case "switch": {
      let s = `switch (${printTs(node.discriminant, indent)}) {\n`;
      for (const c of node.cases) {
        if (c.test) {
          s += `${ind(indent + 1)}case ${printTs(c.test, indent + 1)}:\n`;
        } else {
          s += `${ind(indent + 1)}default:\n`;
        }
        s += printBody(c.body, indent + 1) + "\n";
      }
      s += `${ind(indent)}}`;
      return s;
    }

    case "tryCatch": {
      const catchClause = node.catchParam
        ? `catch (${node.catchParam})`
        : "catch";
      let result = `try {\n${printBody(node.tryBody, indent)}\n${ind(indent)}} ${catchClause} {\n${printBody(node.catchBody, indent)}\n${ind(indent)}}`;
      if (node.finallyBody) {
        result += ` finally {\n${printBody(node.finallyBody, indent)}\n${ind(indent)}}`;
      }
      return result;
    }

    case "binOp": {
      const left = node.parenLeft
        ? `(${printTs(node.left, indent)})`
        : printTs(node.left, indent);
      const right = node.parenRight
        ? `(${printTs(node.right, indent)})`
        : printTs(node.right, indent);
      return `${left} ${node.op} ${right}`;
    }

    case "propertyAccess": {
      const obj = printTs(node.object, indent);
      if (node.computed) {
        return `${obj}[${printTs(node.property as TsNode, indent)}]`;
      }
      return `${obj}.${node.property as string}`;
    }

    case "spread":
      return `...${printTs(node.expr, indent)}`;

    case "identifier":
      return node.name;

    case "stringLiteral":
      return JSON.stringify(node.value);

    case "numericLiteral":
      return String(node.value);

    case "booleanLiteral":
      return String(node.value);

    case "comment":
      if (node.block) return `/* ${node.text} */`;
      return `// ${node.text}`;

    case "export": {
      if (node.decl) return `export ${printTs(node.decl, indent)}`;
      if (node.names) return `export { ${node.names.join(", ")} };`;
      return "export {};";
    }

    case "newExpr": {
      const callee = printTs(node.callee, indent);
      const args = node.arguments.map((a) => printTs(a, indent)).join(", ");
      return `new ${callee}(${args})`;
    }

    case "scopedVar": {
      if (node.scope === "global" && node.moduleId) {
        return `__ctx.globals.get(${JSON.stringify(node.moduleId)}, ${JSON.stringify(node.name)})`;
      }
      const prefix = scopeToPrefix(node.scope);
      if (prefix === "") return node.name;
      return `${prefix}.${node.name}`;
    }

    case "functionReturn":
      return `return ${printTs(node.value, indent)}`;

    case "stepBlock": {
      const stepBody = printBody(node.body, indent);
      if (node.subStep) {
        const subKey = node.subStep.join("_");
        return renderSubstepBlock.default({
          guardVar: `__sub_${subKey}`,
          stepIndex: node.stepIndex,
          body: stepBody,
          counterExpr: `__stack.locals.__substep_${subKey}`,
          nextIndex: node.stepIndex + 1,
        });
      }
      const guard = node.branchKey
        ? `if (__step <= ${node.stepIndex} || (__stack.branches && __stack.branches["${node.branchKey}"])) {`
        : `if (__step <= ${node.stepIndex}) {`;
      return `${guard}
      ${stepBody}
      ${ind(indent + 1)}__stack.step++;\n${ind(indent)}}`;
    }

    case "ifSteps": {
      const subKey = node.subStepPath.join("_");
      const condbranchVar = `__condbranch_${subKey}`;
      const condbranchStore = `__stack.locals.__condbranch_${subKey}`;
      const subVar = `__sub_${subKey}`;
      const subStore = `__stack.locals.__substep_${subKey}`;

      const condbranchCode = renderIfStepsCondbranch.default({
        condbranchStore,
        condbranchVar,
        subVar,
        subStore,
        branches: node.branches.map((b, i) => ({
          condition: printTs(b.condition, indent + 1),
          condbranchStore,
          index: i,
          first: i === 0,
        })),
        hasElse: !!node.elseBranch,
        elseIndex: node.branches.length,
      });

      const allBranches = [...node.branches.map(b => b.body)];
      if (node.elseBranch) allBranches.push(node.elseBranch);

      const dispatchCode = renderIfStepsBranchDispatch.default({
        allBranches: allBranches.map((body, branchIdx) => ({
          branchIndex: branchIdx,
          first: branchIdx === 0,
          condbranchVar,
          subVar,
          subStore,
          statements: body.map((stmt, stmtIdx) => ({
            stmtIndex: stmtIdx,
            stmtCode: printTs(stmt, indent + 2),
            nextIndex: stmtIdx + 1,
            subVar,
            subStore,
          })),
        })),
      });

      return condbranchCode + "\n" + dispatchCode;
    }

    case "threadSteps": {
      const subKey = node.subStepPath.join("_");
      const subVar = `__sub_${subKey}`;
      const subStore = `__stack.locals.__substep_${subKey}`;

      // Ensure each code block ends with a newline to prevent line concatenation
      const ensureNewline = (s: string) => s.endsWith("\n") ? s : s + "\n";

      return renderThreadSteps.default({
        subVar,
        subStore,
        setup: ensureNewline(node.setup.map((s) => printTs(s, indent + 1)).join("\n")),
        bodyStatements: node.body.map((stmt, i) => ({
          subVar,
          subStore,
          index: i + 1,
          code: ensureNewline(printTs(stmt, indent + 1)),
          nextIndex: i + 2,
        })),
        cleanup: node.cleanup.map((s) => printTs(s, indent)).join("\n") + ";\n",
      });
    }

    case "whileSteps": {
      const subKey = node.subStepPath.join("_");
      const subStore = `__stack.locals.__substep_${subKey}`;
      const iterStore = `__stack.locals.__iteration_${subKey}`;
      const currentIterVar = `__currentIter_${subKey}`;
      const ensureNewline = (s: string) => s.endsWith("\n") ? s : s + "\n";

      return renderWhileSteps.default({
        condition: printTs(node.condition, indent + 1),
        subStore,
        iterStore,
        currentIterVar,
        bodyStatements: node.body.map((stmt, i) => ({
          subStore,
          index: i,
          code: ensureNewline(printTs(stmt, indent + 2)),
          nextIndex: i + 1,
        })),
        resetKeys: node.resetKeys,
      });
    }

    case "forSteps": {
      const subKey = node.subStepPath.join("_");
      const subStore = `__stack.locals.__substep_${subKey}`;
      const iterStore = `__stack.locals.__iteration_${subKey}`;
      const currentIterVar = `__currentIter_${subKey}`;
      const ensureNewline = (s: string) => s.endsWith("\n") ? s : s + "\n";

      const stripSemicolon = (s: string) => s.endsWith(";") ? s.slice(0, -1) : s;

      return renderForSteps.default({
        init: stripSemicolon(printTs(node.init, indent + 1)),
        condition: printTs(node.condition, indent + 1),
        update: printTs(node.update, indent + 1),
        hasItemDecl: !!node.itemDecl,
        itemDecl: node.itemDecl ? printTs(node.itemDecl, indent + 1) : "",
        subStore,
        iterStore,
        currentIterVar,
        bodyStatements: node.body.map((stmt, i) => ({
          subStore,
          index: i,
          code: ensureNewline(printTs(stmt, indent + 2)),
          nextIndex: i + 1,
        })),
        resetKeys: node.resetKeys,
      });
    }

    case "empty":
      return "";

    case "break":
      return "break;";

    case "continue":
      return "continue;";

    case "postfixOp":
      return `${printTs(node.operand, indent)}${node.op}`;
    case "and":
      return `(${node.operands.map((o) => printTs(o, indent)).join(" && ")})`;
    case "or":
      return `(${node.operands.map((o) => printTs(o, indent)).join(" || ")})`;
    case "not":
      return `!${printTs(node.operand, indent)}`;
    case "ternary": {
      const condition = printTs(node.condition, indent);
      const trueExpr = printTs(node.trueExpr, indent);
      const falseExpr = printTs(node.falseExpr, indent);
      return `(${condition} ? (${trueExpr}) : (${falseExpr}))`;
    }

    default: {
      const _exhaustive: never = node;
      throw new Error(`Unknown node kind: ${(_exhaustive as any).kind}`);
    }
  }
}

function printBody(node: TsNode, indent: number): string {
  if (node.kind === "statements") {
    return node.body
      .map((n) => `${ind(indent + 1)}${printTs(n, indent + 1)}`)
      .join("\n");
  }
  return `${ind(indent + 1)}${printTs(node, indent + 1)}`;
}

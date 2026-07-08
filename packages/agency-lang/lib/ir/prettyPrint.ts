import type { TsNode, TsParam, TsScopedVar, TsImportName } from "./tsIR.js";
import renderRunnerIfElse from "../templates/backends/typescriptGenerator/runnerIfElse.js";
import renderAgencyFunctionWrap from "../templates/ir/agencyFunctionWrap.js";

const INDENT = "  ";

function formatImportName(name: TsImportName): string {
  if (typeof name === "string") return name;
  return `${name.name} as ${name.alias}`;
}

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
    case "block":
      return "__bstack.locals";
    case "blockArgs":
      return "__bstack.args";
    case "imported":
    case "static":
    case "functionRef":
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

// eslint-disable-next-line max-lines-per-function -- large switch over TsNode kinds; intentionally kept in one function
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
          return `import type { ${node.names.map(formatImportName).join(", ")} } from ${from};`;
        case "named":
        default:
          return `import { ${node.names.map(formatImportName).join(", ")} } from ${from};`;
      }
    }

    case "varDecl": {
      let s = `${node.declKind} ${node.name}`;
      // let s = `var ${node.name}`;
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
      // Arrow / function-expression callees must be wrapped in parens so
      // they parse as IIFEs, e.g. `(async () => { ... })()` rather than
      // `async () => { ... }()` which is a parse error in statement
      // position and binds wrong in expression position.
      const needsCalleeParens =
        node.callee.kind === "arrowFn" || node.callee.kind === "functionDecl";
      const calleeStr = printTs(node.callee, indent);
      const callee = needsCalleeParens ? `(${calleeStr})` : calleeStr;
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
        if (e.computed) {
          return `${ind(indent + 1)}[${printTs(e.key, indent + 1)}]: ${printTs(e.value, indent + 1)}`;
        }
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
      // Part text is RAW runtime characters — the Agency parser has already
      // interpreted `\n` / `\\` etc. into real chars, so real newlines/tabs
      // pass straight through (valid inside a template literal). Four
      // sequences must be escaped or they corrupt the emitted template:
      //   `\`     → `\\`  (a raw backslash would escape whatever follows —
      //                    a lone `\` before the closing backtick yields an
      //                    unterminated template; must run FIRST so it
      //                    doesn't double the escapes added below)
      //   CR      → `\r`  (ECMAScript normalizes a raw CR/CRLF in template
      //                    source to LF, silently changing the value)
      //   `` ` `` → `\``  (otherwise closes the template)
      //   `${`    → `\${` (otherwise starts an interpolation)
      const escapeForTemplate = (text: string): string =>
        text
          .replace(/\\/g, "\\\\")
          .replace(/\r/g, "\\r")
          .replace(/`/g, "\\`")
          .replace(/\$\{/g, "\\${");
      let s = "`";
      for (const part of node.parts) {
        s += escapeForTemplate(part.text);
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
      if (node.op === "!") {
        const right = node.parenRight
          ? `(${printTs(node.right, indent)})`
          : printTs(node.right, indent);
        return `!${right}`;
      }
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
        const prefix = node.optional ? "?." : "";
        return `${obj}${prefix}[${printTs(node.property as TsNode, indent)}]`;
      }
      const dot = node.optional ? "?." : ".";
      return `${obj}${dot}${node.property as string}`;
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
        // Two receivers depending on emission site:
        //   - `topLevel` true (set on subtrees emitted as part of
        //     eager-evaluated tool description docstrings): use
        //     `__globalCtx.globals` directly. The eager tool-
        //     registration object literal runs at module load, before
        //     any ALS frame is installed, so the accessor would throw.
        //     The canonical store on `__globalCtx` is also the right
        //     read target there — tool descriptions are computed once
        //     at module load, not per-branch.
        //   - default (inside any function/node body, under the
        //     `withAlsFrame` wrap): use `__globals()!`, the per-
        //     scope accessor. Routing through the ALS slot is what
        //     gives per-branch isolation in Stage 2: the branch's
        //     cloned GlobalStore is read here instead of the
        //     canonical one.
        const receiver = node.topLevel
          ? "__globalCtx.globals"
          : "__globals()!";
        return `${receiver}.get(${JSON.stringify(node.moduleId)}, ${JSON.stringify(node.name)})`;
      }
      if (node.scope === "static") {
        // Wrap static reads in `__readStatic` so that reading a static
        // before its initializer has run throws a clear, actionable
        // error (the `let` binding holds the sentinel
        // `__UNINIT_STATIC` until then). The wrapper is transparent
        // for initialized values — `__readStatic(x, ...)` returns `x`
        // unchanged — so binary operations, template interpolations,
        // indexing, etc. continue to work without any other change.
        //
        // `moduleId` may be undefined for static-scoped scopedVars
        // produced in contexts where it wasn't propagated; fall back
        // to the empty string in that case so the error message still
        // points at the variable name.
        const moduleIdLit = JSON.stringify(node.moduleId ?? "");
        return `__readStatic(${node.name}, ${JSON.stringify(node.name)}, ${moduleIdLit})`;
      }
      if (
        (node.scope === "block" || node.scope === "blockArgs") &&
        node.blockFrameVar
      ) {
        // An ancestor block's variable: address its uniquely-named frame
        // binding (in lexical closure scope) instead of the nearest
        // `__bstack`. Absent blockFrameVar (current/innermost block)
        // falls through to scopeToPrefix's `__bstack.*` default.
        const sub = node.scope === "block" ? "locals" : "args";
        return `${node.blockFrameVar}.${sub}.${node.name}`;
      }
      const prefix = scopeToPrefix(node.scope);
      if (prefix === "") return node.name;
      return `${prefix}.${node.name}`;
    }

    case "functionReturn":
      return `__functionCompleted = true;\nrunner.halt(${printTs(node.value, indent)});\nreturn;`;

    // ── Runner-based step IR nodes ──

    case "runnerStep": {
      const body = node.body.map((n) => printTs(n, indent + 1)).join("\n");
      return `await runner.step(${node.id}, async (runner) => {\n${body}\n${ind(indent)}});`;
    }

    case "runnerThread": {
      const body = node.body.map((n) => printTs(n, indent + 1)).join("\n");
      const optsParts: string[] = [];
      if (node.label) optsParts.push(`label: ${printTs(node.label, indent)}`);
      if (node.summarize) optsParts.push(`summarize: ${printTs(node.summarize, indent)}`);
      if (node.continueExpr) optsParts.push(`continueId: ${printTs(node.continueExpr, indent)}`);
      if (node.sessionExpr) optsParts.push(`session: ${printTs(node.sessionExpr, indent)}`);
      if (node.hidden) optsParts.push(`hidden: ${printTs(node.hidden, indent)}`);
      // Always pass an opts object so Runner.thread has a single,
      // uniform signature: legacy callers see `{}` and the
      // hook-firing path can treat opts as required.
      //
      // The opts object is emitted as a thunk (`async () => (<opts>)`) so its
      // value expressions (`label`, `session`, ...) are evaluated inside
      // `runner.thread`, AFTER its halt/skip guards. An early `return` earlier
      // in the function halts the runner and skips the steps that assign the
      // locals those expressions reference; evaluating them eagerly here would
      // then dereference an unset local and throw. Deferring lets the early
      // return win — same fix as `runnerLoop`.
      const optsObj = optsParts.length === 0 ? "{}" : `{ ${optsParts.join(", ")} }`;
      return `await runner.thread(${node.id}, "${node.method}", async () => (${optsObj}), async (runner) => {\n${body}\n${ind(indent)}});`;
    }

    case "runnerHandle": {
      const handler = printTs(node.handler, indent);
      const body = node.body.map((n) => printTs(n, indent + 1)).join("\n");
      return `await runner.handle(${node.id}, ${handler}, async (runner) => {\n${body}\n${ind(indent)}});`;
    }

    case "runnerHookStep": {
      const body = node.body.map((n) => printTs(n, indent + 1)).join("\n");
      return `await runner.hook(${node.id}, async () => {\n${body}\n${ind(indent)}});`;
    }

    case "withHandler": {
      const handler = printTs(node.handler, indent);
      const body = `${ind(indent + 1)}${printTs(node.body, indent + 1)}`;
      // Strict accessor — `withHandler` is emitted from
      // `sectionAssembler.ts` only for top-level static / global init
      // wrappers, which always execute under `runInBootstrapFrame(...)`
      // (see runtime/node.ts, runtime/interrupts.ts, runtime/rewind.ts).
      // A missing frame is a genuine bug, so let it throw clearly
      // instead of producing a cryptic "Cannot read 'pushHandler' of
      // undefined". Handlers are safety infrastructure — failing loud
      // here is preferable to silently skipping registration.
      return `getRuntimeContext().ctx.pushHandler(${handler});\n${ind(indent)}try {\n${body}\n${ind(indent)}} finally {\n${ind(indent + 1)}getRuntimeContext().ctx.popHandler();\n${ind(indent)}}`;
    }

    case "runnerDebugger": {
      return `await runner.debugger(${node.id}, ${JSON.stringify(node.label)});`;
    }

    case "runnerPipe": {
      const target = printTs(node.target, indent);
      const input = printTs(node.input, indent);
      const fn = printTs(node.fn, indent);
      return `${target} = await runner.pipe(${node.id}, ${input}, ${fn});`;
    }

    case "runnerIfElse": {
      const branches = node.branches.map((b) => ({
        condition: printTs(b.condition, indent + 2),
        body: b.body.map((n) => printTs(n, indent + 3)).join("\n"),
      }));
      const elseBranch = node.elseBranch
        ? node.elseBranch.map((n) => printTs(n, indent + 2)).join("\n")
        : "";
      // Precompute the trailing opts arg as a single string. Typestache's
      // inverted sections don't nest reliably, and this keeps the template
      // fully inert when `matchId` is undefined (byte-identical output).
      const matchOpts =
        node.matchId === undefined
          ? ""
          : node.elseBranch
            ? `, { matchId: ${node.matchId} }`
            : `, undefined, { matchId: ${node.matchId} }`;
      return renderRunnerIfElse({
        id: node.id,
        branches,
        hasElse: !!node.elseBranch,
        elseBranch,
        matchOpts,
      });
    }

    case "runnerExitMatch": {
      // Same halt+return shape as `functionReturn`: the leading indent for
      // the first line is supplied by the caller (printBody); continuation
      // lines are un-indented, matching the runnerHalt/functionReturn case.
      const value = printTs(node.value, indent);
      return `runner.exitMatch(${node.matchId}, ${value});\nreturn;`;
    }

    case "runnerLoop": {
      // The iterable is emitted as a thunk (`async () => (<expr>)`) so its
      // expression is evaluated inside `runner.loop`, AFTER the halt/skip
      // guards. An early `return` earlier in the function halts the runner and
      // skips the steps that assign the iterable's backing locals; evaluating
      // the iterable eagerly here would then dereference an unset local and
      // throw. Deferring it lets the early return win. Mirrors how
      // `runnerWhileLoop` wraps its condition.
      //
      // The expression MUST be parenthesized: a bare `async () => ${items}`
      // breaks when the iterable prints as an object literal (record
      // iteration over a literal, e.g. `for (k in { a: 1 })`) — `async () => {
      // a: 1 }` parses as a function BODY block, not an object. The parens
      // force expression context. (Same reason `runnerThread` wraps its opts.)
      const items = printTs(node.items, indent + 1);
      const idxVar = node.indexVar ?? "_";
      const body = node.body.map((n) => printTs(n, indent + 1)).join("\n");
      return `await runner.loop(${node.id}, async () => (${items}), async (${node.itemVar}, ${idxVar}, runner) => {\n${body}\n${ind(indent)}});`;
    }

    case "runnerWhileLoop": {
      const cond = printTs(node.condition, indent + 1);
      const body = node.body.map((n) => printTs(n, indent + 1)).join("\n");
      // The condition arrow MUST be `async` because the TS builder always
      // emits `await` around function calls; a non-async wrapper would
      // produce `() => await fn(...)`, which is a syntax error. The runtime
      // `whileLoop` accepts `() => boolean | Promise<boolean>` and awaits
      // the result, so a sync condition like `x < 3` still works (a sync
      // value inside an async arrow is wrapped as Promise<boolean>).
      return `await runner.whileLoop(${node.id}, async () => ${cond}, async (runner) => {\n${body}\n${ind(indent)}});`;
    }

    case "runnerBranchStep": {
      const body = node.body.map((n) => printTs(n, indent + 1)).join("\n");
      return `await runner.branchStep(${node.id}, "${node.branchKey}", async (runner) => {\n${body}\n${ind(indent)}});`;
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
    case "unaryOp": {
      const operand = node.paren
        ? `(${printTs(node.operand, indent)})`
        : printTs(node.operand, indent);
      // Keyword operators (typeof, void) need a space; symbol operators (!) don't
      const sep = /^[a-z]/i.test(node.op) ? " " : "";
      return `${node.op}${sep}${operand}`;
    }
    case "ternary": {
      const condition = printTs(node.condition, indent);
      const trueExpr = printTs(node.trueExpr, indent);
      const falseExpr = printTs(node.falseExpr, indent);
      return `(${condition} ? (${trueExpr}) : (${falseExpr}))`;
    }

    case "agencyFunctionWrap": {
      const fnStr = printTs(node.fn, indent);
      const paramsStr = node.params
        .map(p => `{ name: ${JSON.stringify(p.name)}, hasDefault: false, defaultValue: undefined, variadic: false }`)
        .join(", ");
      return renderAgencyFunctionWrap({
        name: JSON.stringify(node.name),
        module: JSON.stringify(node.module),
        fn: fnStr,
        paramsStr,
      });
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

// Fails when code in lib/ can read the current run after an `await`.
//   node scripts/lint-run-reads.mjs          (run by `pnpm run lint:structure`)
//   node scripts/lint-run-reads.mjs --list   (also print every function that reads on entry)
//
// `currentRun()` returns the run a plain function was called under. The
// runtime sets it for the synchronous part of the call, so it is only right
// until the function's first `await`. After that it throws. This check finds
// the mistake before the code runs:
//
//   export async function _save(path: string) {
//     await mkdir(dirname(path));
//     const run = currentRun();   // reported: read after an await
//   }
//
// It follows calls. A function "reads on entry" when it reads the run, or
// calls a function that reads on entry, before its own first `await`. Calling
// such a function after an `await` is the same mistake one level up:
//
//   export async function _saveAll(paths: string[]) {
//     await prepare();
//     await _save(paths[0]);      // reported: _save reads the run on entry
//   }
//
// The fix is the same in both: take the run on the function's first line and
// pass it down, or call the helper with `callPlain(run, helper, args)`.
//
// What it cannot see:
//  - A call through a value it cannot resolve to one declaration: a callback
//    parameter, a method picked at run time, a function stored in a table.
//  - A function handed to code outside lib/ that calls it later.
// Those still throw when they run. See docs/dev/runtime/async-context.md.
import ts from "typescript";
import { join, relative, resolve } from "node:path";

const root = resolve(".");
const listEntryReaders = process.argv.includes("--list");

const config = ts.getParsedCommandLineOfConfigFile(
  join(root, "tsconfig.json"),
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
);
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();

const relativePath = (file) => relative(root, file.fileName);
const inScope = (file) => {
  const path = relativePath(file);
  return (
    path.startsWith("lib/") &&
    !path.includes(".test.") &&
    !path.includes("__tests__") &&
    !file.isDeclarationFile
  );
};
const files = program.getSourceFiles().filter(inScope);

// The functions that read the variable `callPlain` sets. Everything else is
// found by following calls to these.
const READER_FILE = "lib/runtime/asyncContext.ts";
const READER_NAMES = ["currentRun", "currentRunOrNone", "getRuntimeContext"];

// A function literal handed to one of these runs later, in its own turn of
// the event loop. Whatever run was current when it was handed over is gone.
const DEFERRING_CALLS = [
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "nextTick",
  "then",
  "catch",
  "finally",
  "on",
  "once",
  "addListener",
  "addEventListener",
];

// A line may opt out with a comment that says why:
//   // run-read-ok: <reason>
const OPT_OUT = "run-read-ok:";

const isFunctionLike = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

const isLoop = (node) =>
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isWhileStatement(node) ||
  ts.isDoStatement(node);

function innermostFunction(node) {
  let current = node.parent;
  while (current && !isFunctionLike(current)) current = current.parent;
  return current ?? null;
}

function describe(fn) {
  const file = relativePath(fn.getSourceFile());
  const line = fn.getSourceFile().getLineAndCharacterOfPosition(fn.getStart()).line + 1;
  let name = "";
  if (fn.name) name = fn.name.getText();
  else if (
    fn.parent &&
    (ts.isVariableDeclaration(fn.parent) ||
      ts.isPropertyAssignment(fn.parent) ||
      ts.isPropertyDeclaration(fn.parent))
  ) {
    name = fn.parent.name.getText();
  }
  return name ? `${name} (${file}:${line})` : `a function at ${file}:${line}`;
}

function locationOf(node) {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart());
  return `${relativePath(file)}:${line + 1}`;
}

function hasOptOut(node) {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart());
  const lines = file.text.split("\n");
  return lines[line].includes(OPT_OUT) || (line > 0 && lines[line - 1].includes(OPT_OUT));
}

/** The function a call names, when it resolves to one declaration in lib/. */
function targetOf(call) {
  const expression = call.expression;
  const at = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  let symbol = checker.getSymbolAtLocation(at);
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (!inScope(declaration.getSourceFile())) continue;
    if (isFunctionLike(declaration)) return declaration;
    const holdsValue =
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration) ||
      ts.isPropertyDeclaration(declaration);
    if (!holdsValue || !declaration.initializer) continue;
    let value = declaration.initializer;
    // `llm: _llm` in an object literal: follow the name to its function.
    if (ts.isIdentifier(value)) {
      let named = checker.getSymbolAtLocation(value);
      if (named && named.flags & ts.SymbolFlags.Alias) named = checker.getAliasedSymbol(named);
      const found = named?.declarations?.find(
        (candidate) =>
          isFunctionLike(candidate) ||
          (ts.isVariableDeclaration(candidate) &&
            candidate.initializer &&
            isFunctionLike(candidate.initializer)),
      );
      if (found) value = isFunctionLike(found) ? found : found.initializer;
    }
    if (isFunctionLike(value)) return value;
  }
  return null;
}

function isReader(fn) {
  return (
    ts.isFunctionDeclaration(fn) &&
    fn.name !== undefined &&
    READER_NAMES.includes(fn.name.text) &&
    relativePath(fn.getSourceFile()) === READER_FILE
  );
}

// ---- Pass 1: what each function does in its own body ----------------------
//
// `calls` and `awaits` belong to the innermost function around them. A nested
// function literal is its own function: its body runs when it is called, not
// where it is written.

const facts = []; // { fn, calls: [{ node, target }], awaits: [node], deferred: [fn] }
const factsOf = (fn) => {
  let found = facts.find((entry) => entry.fn === fn);
  if (!found) {
    found = { fn, calls: [], awaits: [], deferred: [] };
    facts.push(found);
  }
  return found;
};

for (const file of files) {
  const visit = (node) => {
    const owner = innermostFunction(node);
    if (owner) {
      if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
        factsOf(owner).awaits.push(node);
      }
      if (ts.isCallExpression(node)) {
        const target = targetOf(node);
        if (target) factsOf(owner).calls.push({ node, target });
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : "";
      if (DEFERRING_CALLS.includes(calleeName)) {
        for (const argument of node.arguments) {
          if (isFunctionLike(argument)) factsOf(argument).deferredBy = calleeName;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

/** Where the wait of an await ends: after this point the function has been
 *  suspended at least once. For `for await`, the loop body is after it. */
function waitEnd(awaitNode) {
  return ts.isForOfStatement(awaitNode) ? awaitNode.expression.getEnd() : awaitNode.getEnd();
}

/** The loops of `fn` that contain `node`, innermost first. */
function loopsAround(node, fn) {
  const loops = [];
  let current = node.parent;
  while (current && current !== fn) {
    if (isLoop(current)) loops.push(current);
    current = current.parent;
  }
  return loops;
}

/** Has `fn` waited at least once by the time it reaches `call`? */
function isAfterAwait(entry, call) {
  const callStart = call.getStart();
  const callLoops = loopsAround(call, entry.fn);
  return entry.awaits.some((awaitNode) => {
    if (waitEnd(awaitNode) <= callStart) return true;
    // An await later in the same loop comes before this call on the next
    // time round.
    return loopsAround(awaitNode, entry.fn).some((loop) => callLoops.includes(loop));
  });
}

// ---- Pass 2: which functions read the run on entry ------------------------

const readsOnEntry = []; // function nodes
const reason = []; // parallel to readsOnEntry: the call that makes it so
const entryIndex = (fn) => readsOnEntry.indexOf(fn);

let changed = true;
while (changed) {
  changed = false;
  for (const entry of facts) {
    if (entryIndex(entry.fn) !== -1) continue;
    const call = entry.calls.find(
      ({ node, target }) =>
        (isReader(target) || entryIndex(target) !== -1) &&
        !isAfterAwait(entry, node) &&
        !hasOptOut(node),
    );
    if (call) {
      readsOnEntry.push(entry.fn);
      reason.push(call);
      changed = true;
    }
  }
}

function chainFrom(target) {
  const steps = [];
  let current = target;
  while (current && !isReader(current) && steps.length < 12) {
    steps.push(describe(current));
    const index = entryIndex(current);
    current = index === -1 ? null : reason[index].target;
  }
  return steps;
}

// ---- Pass 3: report --------------------------------------------------------

const problems = [];

for (const entry of facts) {
  for (const { node, target } of entry.calls) {
    const reads = isReader(target) || entryIndex(target) !== -1;
    if (!reads || hasOptOut(node)) continue;
    if (!isAfterAwait(entry, node)) continue;
    const chain = chainFrom(target);
    problems.push({
      where: locationOf(node),
      message: isReader(target)
        ? `${describe(entry.fn)} reads the current run after an await.`
        : `${describe(entry.fn)} calls ${chain[0]} after an await, and that reads the current run on entry.`,
      chain: chain.slice(1),
    });
  }
  if (entry.deferredBy && entryIndex(entry.fn) !== -1) {
    const index = entryIndex(entry.fn);
    const call = reason[index];
    if (!hasOptOut(call.node)) {
      problems.push({
        where: locationOf(call.node),
        message:
          `A function handed to ${entry.deferredBy}() reads the current run. ` +
          `It runs later, when no run is current.`,
        chain: chainFrom(call.target),
      });
    }
  }
}

if (listEntryReaders) {
  console.log(`${readsOnEntry.length} functions read the current run on entry:`);
  for (const fn of readsOnEntry) console.log(`  ${describe(fn)}`);
  console.log("");
}

if (problems.length === 0) {
  console.log(
    `lint-run-reads: no read of the current run after an await ` +
      `(${readsOnEntry.length} functions read it on entry).`,
  );
  process.exit(0);
}

for (const problem of problems) {
  console.error(`${problem.where}`);
  console.error(`  ${problem.message}`);
  for (const step of problem.chain) console.error(`    which calls ${step}`);
}
console.error("");
console.error(
  `lint-run-reads: ${problems.length} place(s) can read the current run after an await.\n` +
    "The run is only current until a function's first await. Take it on the first line\n" +
    "(`const run = currentRun()`) and pass it down, or call the helper with\n" +
    "`callPlain(run, helper, args)`. If a line is safe for a reason this check cannot\n" +
    `see, put \`// ${OPT_OUT} <reason>\` on it or on the line above.`,
);
process.exit(1);

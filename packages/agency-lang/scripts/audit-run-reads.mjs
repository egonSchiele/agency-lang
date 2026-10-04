// A static audit of how the runtime reads its hidden context.
//   node scripts/audit-run-reads.mjs . > audit.json
//
// It answers: which functions need the run, which of them are already handed
// run state by their caller, and which would need it threaded to them.
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: () => {},
});
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();

const inScope = (file) => {
  const rel = relative(root, file.fileName);
  return rel.startsWith("lib/") && !rel.includes(".test.") && !rel.includes("__tests__") && !file.isDeclarationFile;
};
const files = program.getSourceFiles().filter(inScope);

// Types that mean "the caller already hands this function run state".
const RUN_TYPES = [
  "RuntimeContext",
  "StateStack",
  "Run",
  "Runner",
  "PromptRunner",
  "BranchRunner",
  "InternalFunctionState",
  "RunSession",
  "ThreadStore",
  "State",
];

const isFunctionLike = (n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

/** The named function a node belongs to. An unnamed closure belongs to the
 *  named function around it. */
function ownerOf(node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) {
      if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current;
      if (ts.isConstructorDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) return current;
      const p = current.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return current;
      if (p && ts.isPropertyAssignment(p) && p.parent && ts.isObjectLiteralExpression(p.parent)) {
        const gp = p.parent.parent;
        if (gp && ts.isVariableDeclaration(gp)) return current;
      }
      if (p && ts.isPropertyDeclaration(p)) return current;
    }
    current = current.parent;
  }
  return null;
}

function nameOf(fn) {
  const file = relative(root, fn.getSourceFile().fileName);
  let name = "<anonymous>";
  if (ts.isConstructorDeclaration(fn)) name = `${fn.parent.name?.text ?? "class"}.constructor`;
  else if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
    const cls = fn.parent && (ts.isClassDeclaration(fn.parent) || ts.isClassExpression(fn.parent)) ? fn.parent.name?.text : null;
    name = `${cls ? cls + "." : ""}${fn.name.getText()}`;
  } else if (fn.name) name = fn.name.text;
  else if (fn.parent && (ts.isVariableDeclaration(fn.parent) || ts.isPropertyAssignment(fn.parent) || ts.isPropertyDeclaration(fn.parent))) {
    name = fn.parent.name.getText();
  }
  return { file, name, id: `${file}:${name}` };
}

function isStorage(expr) {
  const type = checker.getTypeAtLocation(expr);
  return type.symbol?.name === (process.env.STORAGE_TYPE ?? "AsyncLocalStorage");
}

/** Resolve a call to the function declaration it names, when it is in lib/. */
function targetOf(call) {
  const expr = call.expression;
  const at = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
  let symbol = checker.getSymbolAtLocation(at);
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  for (const decl of symbol.declarations ?? []) {
    if (!inScope(decl.getSourceFile())) continue;
    if (isFunctionLike(decl)) return decl;
    if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
      let init = decl.initializer;
      // `llm: _llm` in an object literal: follow the identifier.
      if (ts.isIdentifier(init)) {
        let s = checker.getSymbolAtLocation(init);
        if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
        const d = s?.declarations?.find((x) => isFunctionLike(x) || (ts.isVariableDeclaration(x) && x.initializer && isFunctionLike(x.initializer)));
        if (d) init = isFunctionLike(d) ? d : d.initializer;
      }
      if (isFunctionLike(init)) return init;
    }
  }
  return null;
}

const fns = {}; // id -> record
function record(fn) {
  const { file, name, id } = nameOf(fn);
  fns[id] ??= { id, file, name, node: fn, reads: [], installs: [], calls: [], callers: [], concurrent: [], listeners: [] };
  return fns[id];
}

const moduleLevel = { reads: [], installs: [] };

for (const file of files) {
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const owner = ownerOf(node);
      const expr = node.expression;
      const where = `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      if (ts.isPropertyAccessExpression(expr) && isStorage(expr.expression)) {
        const kind = expr.name.text === "getStore" ? "reads" : expr.name.text === "run" || expr.name.text === "exit" ? "installs" : null;
        if (kind) (owner ? record(owner)[kind] : moduleLevel[kind]).push({ where, store: expr.expression.getText(), pos: node.getStart() });
      } else if (owner) {
        const text = expr.getText();
        if (/^Promise\.(all|allSettled|race|any)$/.test(text)) record(owner).concurrent.push({ where, what: text });
        if (ts.isPropertyAccessExpression(expr) && /^(on|once|addEventListener|addListener)$/.test(expr.name.text)) {
          record(owner).listeners.push({ where, what: node.getText().slice(0, 60).replace(/\s+/g, " ") });
        }
        const target = targetOf(node);
        if (target) {
          const targetOwner = isFunctionLike(target) ? target : null;
          if (targetOwner) record(owner).calls.push({ to: nameOf(targetOwner).id, node: targetOwner, where, pos: node.getStart() });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

// Make sure every call target has a record, then link callers.
for (const fn of Object.values(fns)) for (const call of fn.calls) record(call.node);
for (const fn of Object.values(fns)) {
  for (const call of fn.calls) fns[call.to].callers.push({ from: fn.id, where: call.where });
}

// A function needs the run if it reads the context or calls one that does.
const needs = {};
for (const fn of Object.values(fns)) if (fn.reads.length > 0) needs[fn.id] = true;
let changed = true;
while (changed) {
  changed = false;
  for (const fn of Object.values(fns)) {
    if (needs[fn.id]) continue;
    if (fn.calls.some((c) => needs[c.to])) {
      needs[fn.id] = true;
      changed = true;
    }
  }
}

function runStateInReach(fn) {
  const node = fn.node;
  const found = [];
  for (const param of node.parameters ?? []) {
    const text = param.type ? param.type.getText() : checker.typeToString(checker.getTypeAtLocation(param));
    for (const t of RUN_TYPES) if (new RegExp(`\\b${t}\\b`).test(text)) found.push(`${param.name.getText()}: ${t}`);
  }
  const cls = node.parent && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) ? node.parent : null;
  if (cls) {
    const clsName = cls.name?.text ?? "";
    if (RUN_TYPES.includes(clsName)) found.push(`this: ${clsName}`);
    for (const member of cls.members) {
      if (ts.isPropertyDeclaration(member) && member.type) {
        for (const t of RUN_TYPES) if (new RegExp(`\\b${t}\\b`).test(member.type.getText())) found.push(`this.${member.name.getText()}: ${t}`);
      }
    }
  }
  return found;
}

/** Does the function touch the context after its first own `await`? */
function readsAfterAwait(fn) {
  let firstAwait = Infinity;
  const visit = (node) => {
    if (node !== fn.node && isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node)) firstAwait = Math.min(firstAwait, node.getStart());
    ts.forEachChild(node, visit);
  };
  visit(fn.node);
  const uses = [...fn.reads.map((r) => r.pos), ...fn.calls.filter((c) => needs[c.to]).map((c) => c.pos)];
  return uses.some((pos) => pos > firstAwait);
}

// Where the outside reaches in: generated code, and Agency stdlib imports.
function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}
const templateText = walk(join(root, "lib/templates"), ".mustache").map((f) => readFileSync(f, "utf-8")).join("\n") +
  readFileSync(join(root, "lib/ir/builders.ts"), "utf-8") + readFileSync(join(root, "lib/backends/typescriptBuilder.ts"), "utf-8");
const agencyImports = {};
for (const f of walk(join(root, "stdlib"), ".agency")) {
  const text = readFileSync(f, "utf-8");
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*\.js["']/g)) {
    for (const name of m[1].split(",")) agencyImports[name.trim().split(/\s+as\s+/)[0]] = true;
  }
}
const agencyNamespace = readFileSync(join(root, "lib/runtime/agency.ts"), "utf-8");

const rows = [];
for (const fn of Object.values(fns)) {
  if (!needs[fn.id]) continue;
  const inReach = runStateInReach(fn);
  const callers = fn.callers.map((c) => c.from);
  const uniqueCallers = callers.filter((c, i) => callers.indexOf(c) === i);
  const bare = fn.name.split(".").pop();
  rows.push({
    id: fn.id,
    file: fn.file,
    name: fn.name,
    directReads: fn.reads.length,
    inReach,
    callers: uniqueCallers,
    callSites: fn.callers.length,
    fromGeneratedCode: new RegExp(`\\b${bare}\\(`).test(templateText),
    fromAgencyStdlib: !!agencyImports[bare],
    inAgencyNamespace: fn.file === "lib/runtime/agency.ts" || new RegExp(`[:\\s]${bare}\\b`).test(agencyNamespace.slice(agencyNamespace.indexOf("export const agency"))),
    readsAfterAwait: readsAfterAwait(fn),
    concurrent: fn.concurrent,
    listeners: fn.listeners,
    installs: fn.installs.length,
  });
}

const installsOnly = Object.values(fns).filter((f) => f.installs.length > 0).map((f) => ({ id: f.id, installs: f.installs.map((i) => `${i.where} ${i.store}`) }));
// ---- Second pass: where in a function is the context used? ----------------
// "sync": in the function's own body before its first await. A plain variable
//   set by the caller is still valid here.
// "afterAwait": after an await in the same body. Needs the run held in a
//   local or passed in.
// "closure": inside a nested function. Valid only if that function is called
//   at once.
const AMBIENT = [
  "ipcChildDebug", "statelogClient", "warnDroppedData", "restoreThreadForResume", "getFailurePropagationMode",
  "logWarn", "emitFunctionRefMissError", "claimFrameForScope", "recordMemoryUsageIfInFrame",
  "meteredMemoryDispatch", "DeterministicClient.resolveQueue", "StatelogClient.currentStack",
  // Logging and clocks. Counted on their own: see EXTRA_AMBIENT in the report.
  ...(process.env.EXTRA_AMBIENT ? process.env.EXTRA_AMBIENT.split(",") : []),
];
const AMBIENT_CALLERS = process.env.EXTRA_AMBIENT_CALLERS ? process.env.EXTRA_AMBIENT_CALLERS.split(",") : [];
const PURE_INSTALLERS = Object.values(fns).filter((f) => f.installs.length > 0 && f.reads.length === 0).map((f) => f.id);
const core = {};
for (const fn of Object.values(fns)) if (fn.reads.length > 0 && !AMBIENT.includes(fn.name)) core[fn.id] = true;
changed = true;
while (changed) {
  changed = false;
  for (const fn of Object.values(fns)) {
    if (core[fn.id] || PURE_INSTALLERS.includes(fn.id) || AMBIENT_CALLERS.includes(fn.name)) continue;
    if (fn.calls.some((c) => core[c.to])) {
      core[fn.id] = true;
      changed = true;
    }
  }
}

function innermostFunction(node) {
  let current = node.parent;
  while (current && !isFunctionLike(current)) current = current.parent;
  return current;
}
function firstOwnAwait(fnNode) {
  let first = Infinity;
  const visit = (node) => {
    if (node !== fnNode && isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) first = Math.min(first, node.getStart());
    ts.forEachChild(node, visit);
  };
  visit(fnNode);
  return first;
}
const uses = [];
for (const file of files) {
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const owner = ownerOf(node);
      if (owner) {
        const expr = node.expression;
        const ownerRec = record(owner);
        let what = null;
        if (ts.isPropertyAccessExpression(expr) && isStorage(expr.expression) && expr.name.text === "getStore") {
          what = AMBIENT.includes(ownerRec.name) ? null : "read";
        } else {
          const target = targetOf(node);
          if (target && core[nameOf(target).id]) what = nameOf(target).name;
        }
        if (what) {
          const inner = innermostFunction(node);
          const pos = node.getStart();
          let kind = "sync";
          if (pos > firstOwnAwait(inner)) kind = "afterAwait";
          else if (inner !== owner) {
            const call = inner.parent && ts.isCallExpression(inner.parent) ? inner.parent.expression.getText() : "(stored)";
            kind = "closure:" + call.split("\n")[0].slice(0, 50);
          }
          uses.push({
            owner: ownerRec.id,
            what,
            kind,
            where: `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(pos).line + 1}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

const graph = Object.values(fns).map((f) => ({
  id: f.id,
  reads: f.reads.map((r) => ({ store: r.store, where: r.where })),
  calls: f.calls.map((c) => c.to).filter((c, i, all) => all.indexOf(c) === i),
  inReach: runStateInReach(f),
  callSites: f.callers.length,
}));
console.log(JSON.stringify({ rows, installsOnly, moduleLevel, graph, uses, core: Object.keys(core), pureInstallers: PURE_INSTALLERS }, null, 1));

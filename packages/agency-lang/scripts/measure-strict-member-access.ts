#!/usr/bin/env node
//
// Measure the blast radius of `typechecker.strictMemberAccess: "warn"` across
// the stdlib and the typecheck fixtures. Temporary harness for flow-checker
// PR 5 — quantifies how many sites the strict union-member-access check flags
// (split Result vs general-union) so the default-flip decision is data-driven.
//
// Run: npx tsx scripts/measure-strict-member-access.ts

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseAgency } from "../lib/parser.js";
import { buildCompilationUnit } from "../lib/compilationUnit.js";
import { SymbolTable } from "../lib/symbolTable.js";
import { typeCheck } from "../lib/typeChecker/index.js";
import { discoverAgencyFiles } from "../tests/fixtureDiscovery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STDLIB_DIR = path.resolve(__dirname, "../stdlib");
const FIXTURES_DIR = path.resolve(__dirname, "../tests/typescriptGenerator");

const RESULT_PHRASE = "only available on a";
const UNION_PHRASE = "is not available on every member";

type Hit = { file: string; line: number; kind: "Result" | "union"; message: string };

function measure(name: string, filePath: string): Hit[] {
  const contents = fs.readFileSync(filePath, "utf-8");
  const absPath = path.resolve(filePath);
  const parsed = parseAgency(contents);
  if (!parsed.success) {
    return [];
  }
  let info;
  try {
    const symbolTable = SymbolTable.build(absPath);
    info = buildCompilationUnit(parsed.result, symbolTable, absPath, contents);
  } catch {
    return [];
  }
  const { errors } = typeCheck(
    parsed.result,
    { typechecker: { strictMemberAccess: "warn" } },
    info,
  );
  const hits: Hit[] = [];
  for (const e of errors) {
    const isResult = e.message.includes(RESULT_PHRASE);
    const isUnion = e.message.includes(UNION_PHRASE);
    if (isResult || isUnion) {
      hits.push({
        file: name,
        line: (e.loc?.line ?? -1) + 1, // report 1-indexed for humans
        kind: isResult ? "Result" : "union",
        message: e.message,
      });
    }
  }
  return hits;
}

function collect(label: string, dir: string): Hit[] {
  const files = discoverAgencyFiles(dir);
  const hits: Hit[] = [];
  for (const f of files) {
    hits.push(...measure(`${label}/${f.name}`, f.filePath));
  }
  return hits;
}

const all = [...collect("stdlib", STDLIB_DIR), ...collect("fixtures", FIXTURES_DIR)];

for (const h of all) {
  console.log(`${h.file}:${h.line}  [${h.kind}]  ${h.message}`);
}

const result = all.filter((h) => h.kind === "Result").length;
const union = all.filter((h) => h.kind === "union").length;
const files = new Set(all.map((h) => h.file)).size;
console.log("");
console.log(`Result hits: ${result} | union hits: ${union} | files touched: ${files}`);

#!/usr/bin/env node
// Deterministic grader for the fix-git eval.
//
// Mirrors the terminal-bench test_outputs.py check: the md5 of each recovered
// file, with surrounding whitespace stripped, must equal the gold copy. Prints
// a per-file result and a final reward of 1 (both match) or 0.
//
// usage: node grade.mjs <workdir>
//   <workdir> is the personal-site repo the agent worked in.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const workdir = process.argv[2];
if (!workdir) {
  console.error("usage: node grade.mjs <workdir>");
  process.exit(2);
}

// Match Python bytes.strip(): trim leading/trailing ASCII whitespace.
const WS = new Set([9, 10, 11, 12, 13, 32]);
function stripped(buf) {
  let s = 0, e = buf.length;
  while (s < e && WS.has(buf[s])) s++;
  while (e > s && WS.has(buf[e - 1])) e--;
  return buf.subarray(s, e);
}
function md5(path) {
  return createHash("md5").update(stripped(readFileSync(path))).digest("hex");
}

const checks = [
  { name: "about",  got: join(workdir, "_includes/about.md"),    gold: join(HERE, "gold/about.md") },
  { name: "layout", got: join(workdir, "_layouts/default.html"), gold: join(HERE, "gold/default.html") },
];

let pass = true;
for (const c of checks) {
  let ok = false, note = "";
  try {
    ok = md5(c.got) === md5(c.gold);
  } catch (err) {
    note = ` (${err.code || err.message})`;
  }
  if (!ok) pass = false;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}: ${c.got}${note}`);
}
console.log(`\nreward: ${pass ? 1 : 0}`);
process.exit(pass ? 0 : 1);

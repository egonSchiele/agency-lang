// Print the import chain from the entry to a module matching argv[2].
import { build } from "esbuild";
import { readFileSync } from "node:fs";
const meta = JSON.parse(readFileSync(new URL("./meta.json", import.meta.url), "utf-8"));
const target = process.argv[2];
const inputs = meta.inputs;
const parents = {};
const start = Object.keys(inputs).find((k) => k.endsWith(".spike/browser/entry.js"));
const queue = [start]; parents[start] = null;
while (queue.length) {
  const cur = queue.shift();
  for (const imp of inputs[cur]?.imports ?? []) {
    if (!(imp.path in parents)) { parents[imp.path] = cur; queue.push(imp.path); }
  }
}
const hit = Object.keys(parents).find((k) => k.includes(target));
if (!hit) { console.log("not in bundle:", target); process.exit(0); }
const chain = []; for (let c = hit; c; c = parents[c]) chain.unshift(c.replace(/.*node_modules\/\.pnpm\/[^/]+\/node_modules\//, "npm:"));
console.log(chain.join("\n  -> "));

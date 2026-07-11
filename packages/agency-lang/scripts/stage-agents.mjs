// Sync-style agent staging (spec "Agent staging"). Replaces the old
// `rm -rf dist/lib/agents && cp -r` recipe, which deleted every compiled
// agent output on every make and made incremental agent skips impossible.
// Rules:
//   1. copy every file from src over dest (overwrite) — EXCEPT a compiled
//      `.js` whose `.agency` sibling exists in src. Such a `.js` is stale
//      build litter left in the SOURCE tree (agents were once compiled
//      in-place); the compiler is the sole author of the corresponding
//      dest `.js`. Copying it would clobber the compiler's fresh dest
//      output, and the manifest's fresh-skip (keyed on the unchanged
//      `.agency` sourceHash) would then never re-emit it, shipping a stale
//      module that imports symbols its source no longer defines (#498).
//      Handwritten `.js` helpers (no `.agency` sibling) are still copied.
//   2. delete dest files whose source counterpart is gone — a deleted
//      foo.agency takes its compiled foo.js with it;
//   3. never touch dest/docs/ (owned by the stage-agent-docs recipe) and
//      never delete a compiled .js whose .agency source survives.
// Orphan safety is double-covered: this sync deletes orphans, and publish
// still routes through `make clean`.
//
// The tree walk deliberately duplicates lib/cli/util.ts findRecursively:
// this script must run on bare node BEFORE dist exists (make agents can
// run right after make clean), so it cannot import compiled code.
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(child, out);
    } else {
      out.push(child);
    }
  }
  return out;
}

export function syncAgents(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const srcFile of walk(srcDir)) {
    const rel = path.relative(srcDir, srcFile);
    // Never stage a compiled `.js` whose `.agency` sibling lives in src:
    // it is stale build litter, and copying it would clobber the
    // compiler-owned dest output the incremental skip trusts (see rule 1).
    if (rel.endsWith(".js") && fs.existsSync(srcFile.replace(/\.js$/, ".agency"))) {
      continue;
    }
    const destFile = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(srcFile, destFile);
    copied++;
  }
  const deleted = [];
  for (const destFile of walk(destDir)) {
    const rel = path.relative(destDir, destFile);
    if (rel === "docs" || rel.startsWith(`docs${path.sep}`)) {
      continue;
    }
    if (fs.existsSync(path.join(srcDir, rel))) {
      continue;
    }
    if (rel.endsWith(".js")) {
      const agencySibling = rel.replace(/\.js$/, ".agency");
      if (fs.existsSync(path.join(srcDir, agencySibling))) {
        continue; // live compiled output
      }
    }
    fs.unlinkSync(destFile);
    deleted.push(rel);
  }
  return { copied, deleted };
}

// path.resolve for robustness even though node absolutizes argv[1] for
// direct invocations — free hardening against exotic launchers.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) {
    console.error("usage: node stage-agents.mjs <srcDir> <destDir>");
    process.exit(1);
  }
  const { copied, deleted } = syncAgents(src, dest);
  console.log(`staged agents: ${copied} copied, ${deleted.length} orphans removed`);
}

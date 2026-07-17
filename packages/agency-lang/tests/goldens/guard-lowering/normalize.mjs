// Normalizer for the guard-lowering equivalence diff (plan Task 4
// Step 6). Erases exactly the two INTENDED differences between the
// legacy goldens and the construct's desugared output:
//   1. loc/line/col fields (positions shift with the syntax change),
//   2. the callee spelling: `guard` (imported) → `_guard` (prelude),
//      plus the deleted `import { guard }` statement itself and the
//      import's name-list bookkeeping.
// Everything else — __block lifting inputs, argument shapes, body
// structure — must be byte-identical. Dies with the goldens in Task 8.
import { readFileSync } from "fs";

const doc = JSON.parse(readFileSync(process.argv[2], "utf8"));

function walk(node) {
  if (Array.isArray(node)) {
    return node.map(walk).filter((n) => n !== undefined);
  }
  if (node && typeof node === "object") {
    if (node.type === "importStatement") {
      // Drop `guard` from any named-import group; drop the whole
      // statement when nothing remains (the deleted user import).
      const groups = (node.importedNames ?? [])
        .map((g) =>
          g.type === "namedImport" && Array.isArray(g.importedNames)
            ? {
                ...g,
                importedNames: g.importedNames.filter(
                  (n) => n !== "guard" && n !== "_guard",
                ),
              }
            : g,
        )
        .filter(
          (g) =>
            !(g.type === "namedImport" && g.importedNames.length === 0),
        );
      if (groups.length === 0) return undefined;
      // walkFields, NOT walk: re-entering this case with the rebuilt
      // statement recurses forever.
      return walkFields({ ...node, importedNames: groups });
    }
    return walkFields(node);
  }
  return node;
}

function walkFields(node) {
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "loc" || k === "line" || k === "col") continue;
    out[k] = walk(v);
  }
  if (out.type === "functionCall" && out.functionName === "guard") {
    out.functionName = "_guard";
  }
  return out;
}

process.stdout.write(JSON.stringify(walk(doc), null, 1));

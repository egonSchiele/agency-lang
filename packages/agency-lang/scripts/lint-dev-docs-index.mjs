// Fails when the dev docs index in CLAUDE.md is out of step with docs/dev/.
//   node scripts/lint-dev-docs-index.mjs     (run by `pnpm run lint:structure`)
//   node scripts/lint-dev-docs-index.mjs --root <dir> --index <file>
//                                            (check another folder; the tests use this)
//
// The "## Deeper docs" section of CLAUDE.md lists every doc in docs/dev/, one
// line each, so an agent can decide which ones to open:
//
//   - `docs/dev/runtime/lock.md` — A per-run mutex for serializing access to shared resources.
//
// Each description is meant to be one short sentence. Left alone, they grow
// into a list of everything the doc covers, and the whole index is loaded
// into every session. So this check reports:
//  - a description longer than MAX_DESCRIPTION characters
//  - an entry with no description
//  - an entry naming a file that does not exist
//  - a file listed twice
//  - a doc in docs/dev/ that the index does not list
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const MAX_DESCRIPTION = 150;
const SECTION_HEADING = "## Deeper docs";
const ENTRY = /^- `(docs\/[^`]+)`(?: — (.*))?$/;

function flagValue(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

const root = resolve(flagValue("--root", "."));
const indexFile = resolve(flagValue("--index", join(root, "CLAUDE.md")));
const indexName = relative(process.cwd(), indexFile);

/** Every `.md` file under `dir`, as a path relative to `root`. */
function markdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    if (entry.isFile() && entry.name.endsWith(".md")) return [relative(root, path)];
    return [];
  });
}

/** The index entries, each with its 1-based line number in the index file. */
function readEntries(text) {
  const lines = text.split("\n");
  const start = lines.indexOf(SECTION_HEADING);
  if (start === -1) return null;
  const entries = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
    const match = lines[i].match(ENTRY);
    if (match) entries.push({ line: i + 1, path: match[1], description: match[2] ?? "" });
  }
  return entries;
}

function check() {
  const entries = readEntries(readFileSync(indexFile, "utf-8"));
  if (entries === null) return [`${indexName}: no "${SECTION_HEADING}" section`];

  const problems = [];
  const seen = [];
  for (const { line, path, description } of entries) {
    const where = `${indexName}:${line}`;
    const length = [...description].length;
    if (length === 0) {
      problems.push(`${where}: ${path} has no description`);
    } else if (length > MAX_DESCRIPTION) {
      problems.push(
        `${where}: the description of ${path} is ${length} characters; the limit is ${MAX_DESCRIPTION}. ` +
          "Shorten it to one sentence and keep the details in the doc.",
      );
    }
    if (!existsSync(join(root, path))) problems.push(`${where}: ${path} does not exist`);
    if (seen.includes(path)) problems.push(`${where}: ${path} is listed twice`);
    seen.push(path);
  }
  for (const doc of markdownFiles(join(root, "docs/dev"))) {
    if (!seen.includes(doc)) problems.push(`${doc} is not listed in ${indexName}`);
  }
  return problems;
}

const problems = check();
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\n${problems.length} problem(s) in the dev docs index.`);
  process.exit(1);
}

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatSource } from "./formatter.js";
import { parseAgency, replaceBlankLines } from "./parser.js";
import { findRecursively } from "./utils/findRecursively.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A comment must come out of `agency fmt` where it went in.
 *
 * Three different mistakes move or drop a comment, and all three have shipped
 * at least once: a statement stream that skips `completeConstructEntry`, a
 * generator path that renders nodes without going through `processNode`
 * (sorted imports do this), and a node kind whose second parser or renderer
 * was never updated (`guardBlockParser`, `namedImportParser`,
 * `namedExportBodyParser`, and the mixed-import renderer each did this).
 *
 * There are two layers here, because one is not enough:
 *
 * 1. SAMPLES are written in canonical form and must format to themselves,
 *    byte for byte. This is the strong check: it catches a comment that moves
 *    as well as one that vanishes, and it catches loss during PARSING.
 *
 * 2. The corpus check asserts only that no comment disappears between the
 *    parsed tree and the output. It covers far more real code, but it is
 *    deliberately weaker — a comment dropped at parse time is missing from
 *    both sides and passes, and a comment that merely relocates still
 *    appears somewhere. Do not rely on it alone for a new construct; add a
 *    sample.
 *
 * The corpus collector walks for ANY comment node rather than reading the
 * known trivia fields by name. A named list would go stale the moment someone
 * adds a list kind — which is one of the failures this file exists to catch.
 */

/** Every `//` comment the parser produced, wherever it ended up: a standalone
 *  node, a `trailingComment`, or an entry in any list's trivia. */
function collectComments(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectComments(item, found);
    }
    return found;
  }
  if (value === null || typeof value !== "object") {
    return found;
  }
  const node = value as { type?: unknown; content?: unknown };
  if (node.type === "comment" && typeof node.content === "string") {
    found.push(node.content.trim());
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectComments(child, found);
  }
  return found;
}

/** Parse the way `formatSource` does. Blank lines become sentinels before
 *  parsing and statement boundaries depend on it, so skipping that step would
 *  hand this test a different tree than the formatter actually saw. */
function parseLikeFormatter(source: string) {
  return parseAgency(replaceBlankLines(source), {}, false, false);
}

/** How many times each comment body appears, counted in one pass. */
function commentCounts(comments: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const comment of comments) {
    counts[comment] = (counts[comment] ?? 0) + 1;
  }
  return counts;
}

/** The comments in `source` that are missing from `formatted`.
 *
 *  Both sides are counted as parsed comment NODES, not as `//` occurrences in
 *  text. Scanning the text would also count `//` inside a string literal or a
 *  block comment, and that can hide the exact regression this test is for: a
 *  dropped `// keep` passes if the program happens to contain the string
 *  `"// keep"` somewhere. */
function missingComments(source: string, formatted: string): string[] {
  const before = parseLikeFormatter(source);
  if (!before.success) {
    return [];
  }
  const after = parseLikeFormatter(formatted);
  if (!after.success) {
    return ["<formatted output did not re-parse>"];
  }
  const remaining = commentCounts(collectComments(after.result.nodes));
  const missing: string[] = [];
  for (const comment of collectComments(before.result.nodes)) {
    if ((remaining[comment] ?? 0) > 0) {
      remaining[comment] -= 1;
    } else {
      missing.push(comment);
    }
  }
  return missing;
}

/** Every `.agency` file under `relativeDir`, including nested ones — the
 *  fixture directories have subdirectories, and a non-recursive read quietly
 *  skipped ten files that do contain comments. */
function agencyFilesIn(relativeDir: string): string[] {
  const dir = path.join(__dirname, "..", relativeDir);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return [...findRecursively(dir, ".agency")].map((found) => found.path);
}

// Written-out samples, one per construct that can carry a comment. The corpus
// files below are real programs and cover far more shapes, but they only
// contain the comments their authors happened to write; these pin the
// positions this feature actually promises.
const SAMPLES: [string, string][] = [
  ["top-level declaration", `type UserId = string // identifier\n`],
  ["body statement", `node main() {\n  const x = 5 // explains x\n}\n`],
  [
    "inline match arm",
    `node main() {\n  match(x) {\n    1 => "one" // the expected case\n    _ => "other"\n  }\n}\n`,
  ],
  [
    "block match arm",
    `node main() {\n  match(x) {\n    1 => {\n      print(1) // inside\n    }\n  }\n}\n`,
  ],
  [
    "array literal",
    `node main() {\n  const xs = [\n    1, // first\n    2 // second\n  ]\n}\n`,
  ],
  [
    "object literal",
    `node main() {\n  const o = {\n    a: 1, // first\n    b: 2 // second\n  }\n}\n`,
  ],
  ["object type", `type V = {\n  one: number; // first\n  two: string // second\n}\n`],
  [
    "object type inside a wrapper",
    `type V = {\n  one: number // wrapped\n}[]\n`,
  ],
  [
    "call arguments",
    `node main() {\n  save(\n    first, // who\n    second // what\n  )\n}\n`,
  ],
  [
    "named call arguments",
    `node main() {\n  save(\n    value: first, // who\n    retries: 3 // how hard\n  )\n}\n`,
  ],
  [
    "guard arguments",
    `node main() {\n  guard(\n    cost: $1, // budget\n    time: 5m // deadline\n  ) {\n    print(1)\n  }\n}\n`,
  ],
  [
    "interrupt arguments",
    `node main() {\n  interrupt io::read(\n    first, // who\n    second // what\n  )\n}\n`,
  ],
  [
    "function parameters",
    `def save(\n  value: string, // the payload\n  retries: number = 3 // how hard\n) {\n}\n`,
  ],
  [
    "node parameters",
    `node save(\n  value: string, // the payload\n  retries: number = 3 // how hard\n) {\n\n}\n`,
  ],
  ["named import", `import {\n  alpha, // fast path\n  beta // fallback\n} from "./tools"\n`],
  [
    "mixed import",
    `import tools, {\n  alpha // fast path\n} from "./tools"\n`,
  ],
  ["node import", `import node {\n  first, // one\n  second // two\n} from "./n.agency"\n`],
  ["named export", `export {\n  alpha, // fast path\n  beta // fallback\n} from "./tools"\n`],
  [
    "array binding pattern",
    `node main() {\n  const [\n    first, // head\n    second // tail\n  ] = values\n}\n`,
  ],
  [
    "object binding pattern",
    `node main() {\n  const {\n    name, // who\n    age // how old\n  } = user\n}\n`,
  ],
  [
    "thread arguments",
    `node main() {\n  thread(\n    label: "work", // shown in the log\n    hidden: true // kept out of the transcript\n  ) {\n    print(1)\n  }\n}\n`,
  ],
  [
    "parallel arguments",
    `node main() {\n  parallel(\n    shared: true // state mode\n  ) {\n    print(1)\n  }\n}\n`,
  ],
  [
    "standalone comments keep working",
    `node main() {\n  // above\n  const x = 5\n\n  // after a blank line\n  const y = 6\n}\n`,
  ],
  [
    "sorted imports keep their comments",
    `import {\n  alpha // first alphabetically\n} from "./alpha" // the alpha module\nimport {\n  zeta // last alphabetically\n} from "./zeta" // the zeta module\n`,
  ],
];

describe("a comment comes out where it went in", () => {
  // Each sample is already canonical, so formatting must be the identity.
  // Exact equality is what makes this catch a comment that MOVES — checking
  // only that the text survives somewhere would pass on the relocation bug
  // this whole feature exists to fix.
  it.each(SAMPLES)("formats a %s to itself", (_name, source) => {
    expect(formatSource(source)).toBe(source);
  });

  const corpus = [
    ...agencyFilesIn("tests/formatter"),
    ...agencyFilesIn("tests/typescriptGenerator"),
  ];

  it("has a corpus with comments in it, including nested fixtures", () => {
    // Without this the suite below passes vacuously if the corpus moves or
    // stops containing comments. The nested-directory assertion is here
    // because a plain `readdirSync` silently skipped fourteen fixture files
    // and a bare count threshold was too loose to notice.
    expect(corpus.length).toBeGreaterThan(50);
    expect(
      corpus.filter((file) => path.dirname(file).includes("euler")).length,
    ).toBeGreaterThan(0);
    const total = corpus
      .map((file) => fs.readFileSync(file, "utf-8"))
      .map((source) => {
        const parsed = parseLikeFormatter(source);
        return parsed.success ? collectComments(parsed.result.nodes).length : 0;
      })
      .reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThan(20);
  });

  it("keeps every comment in every corpus file", () => {
    const failures: string[] = [];
    for (const file of corpus) {
      const source = fs.readFileSync(file, "utf-8");
      // A fixture that does not parse is some other test's problem.
      if (!parseLikeFormatter(source).success) {
        continue;
      }
      const formatted = formatSource(source);
      if (formatted === null) {
        failures.push(`${path.basename(file)}: did not format`);
        continue;
      }
      for (const comment of missingComments(source, formatted)) {
        failures.push(`${path.basename(file)}: lost //${comment}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

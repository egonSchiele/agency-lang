import { formatted } from "../lib/formatted.js";
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "uses-the-stdlib",
    standard: `
    Here are the four helpers written with the standard library:

    import { extname } from "std::path"

    groupBy(entries, \\e -> extname(e.path))
    unique([extname(e.path) for e in entries], \\x -> x)
    count(entries, \\e -> e.size > limit)
    range(1, pages + 1)

    \`groupBy\`, \`unique\`, \`count\`, and \`range\` are in the prelude and need no import. \`extname\` comes from std::path. Each of the four functions is one line when the writer knows these exist.

    Make sure that:
    1. the extension comes from \`extname\` in std::path, not from splitting the path by hand.
    2. grouping uses \`groupBy\`, distinct values use \`unique\`, and the count uses \`count\` or a comprehension with \`.length\`, not a loop that builds an object or checks an array by hand.
    3. pageNumbers uses \`range\`, not a while loop.

    All three of these points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `import { extname } from "std::path"

export type Entry = { path: string, size: number }

export def byExtension(entries: Entry[]): any {
  return groupBy(entries, \\e -> extname(e.path))
}

export def extensions(entries: Entry[]): string[] {
  return unique([extname(e.path) for e in entries], \\x -> x)
}

export def largeCount(entries: Entry[], limit: number): number {
  return count(entries, \\e -> e.size > limit)
}

export def pageNumbers(pages: number): number[] {
  return range(1, pages + 1)
}`,
  }),
];

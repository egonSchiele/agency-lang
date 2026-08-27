import { formatted } from "../lib/formatted.js";
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "renames-derived-tools",
    weight: 0.6,
    standard: `
    In Agency, you can make a new function from an existing one with \`.partial()\`:

    const listInbox = listDir.partial(dir: "./inbox")
    const listArchive = listDir.partial(dir: "./archive")

    Functions can be passed as tools to an LLM. However, when you pass in a tool made with \`.partial()\`, the LLM sees the original function's name, not the new one. So in this case, the LLM would see two tools both called listDir, and it wouldn't be able to tell them apart. This causes an error.

    The fix is to use \`.rename()\` to give each tool a new name:

    listDir.partial(dir: "./inbox").rename("listInbox").describe("List the files in the inbox.")
    listDir.partial(dir: "./archive").rename("listArchive").describe("List the files in the archive.")

    This example also uses \`.describe()\` to give each tool a description, which is good practice.

    Make sure that:
    1. both tools are made with \`.partial(dir: ...)\`, not by writing two wrapper functions.
    2. each tool is renamed using \`.rename()\`.

    Both of these points count equally towards the final score. Bonus points if each tool has its own description through \`.describe()\`.
    
    If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `export def listDir(dir: string, pattern: string = "*"): string[] {
  """
  List the files in a directory.
  @param dir - the directory to list
  @param pattern - a glob to filter by
  """
  return ["\${dir}/\${pattern}"]
}

export def tools(): any[] {
  return [
    listDir.partial(dir: "./inbox").rename("listInbox").describe("List the files in the inbox."),
    listDir.partial(dir: "./archive").rename("listArchive").describe("List the files in the archive."),
  ]
}`,
  }),
];

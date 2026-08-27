// The holdout proves .partial() can bind both parameters and that a dry
// run leaves the files alone. This judge checks what the holdout cannot:
// the default, and who approves the delete.
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  idiomJudge({
    name: "restrictable-by-partial",
    standard: `
    Here is a delete function a caller can restrict with partial application:

    export def deleteFiles(paths: string[], dryRun: boolean = true): string[] {
      if (!dryRun) {
        for (p in paths) {
          remove(p)
        }
      }
      return paths
    }

    const preview = deleteFiles.partial(dryRun: true)
    const cleanLogs = deleteFiles.partial(paths: ["./logs/a.log"])

    Partial function application is a great way to restrict the capability of a tool before handing it to an agent. For example, we can now hand "preview" as a tool to an agent, and when it calls that tool, we will see what it would have deleted, but the files won't actually get deleted. This is a really great way to make agents safer. 

    We want to check that the agent has written the deleteFiles function in such a way that we can use partial function application to restrict the capabilities of the tool if we want.

    Make sure that:
    1. dryRun is a parameter with the default true.
    2. remove is called without \`with approve\`, and no handler inside the function approves it.

    Both of these points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `import { remove } from "std::fs"

export def deleteFiles(paths: string[], dryRun: boolean = true): string[] {
  """
  Delete files. With dryRun, only list what would be deleted.
  @param paths - the files to delete
  @param dryRun - when true, delete nothing and return the paths
  """
  if (!dryRun) {
    for (p in paths) {
      remove(p)
    }
  }
  return paths
}`,
  }),
];

import { formatted } from "../lib/formatted.js";
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "docstrings-unasked",
    standard: `
    Here is a function with a docstring:

    export def addTask(title: string, due: string = ""): string {
      """
      Add a task to the to-do list.
      @param title - short name of the task
      @param due - due date as YYYY-MM-DD, or leave empty
      """
      tasks.push({ title: title, due: due, done: false })
      return "added \${title}"
    }

    The docstring is the triple-quoted string at the top of the function body. Agency sends it to the LLM as the tool description, so it is written for the LLM that will call the tool. A \`/** ... */\` comment above the def is a different thing and is not sent to the LLM.

    Make sure that:
    1. each of addTask, completeTask, and listOpenTasks has a docstring. A comment above the def, whether \`//\` or \`/** ... */\`, does not count.
    2. each docstring tells the LLM when to call the tool and what to pass. Sentences about how the function is implemented, or sentences that start with "This function", do not count.
    3. each docstring is short: one or two sentences, plus an optional \`@param\` line per parameter. Tokens cost money on every call.

    All three of these points count equally towards the final score. If any of the three functions is missing, or the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `let tasks: { title: string, due: string, done: boolean }[] = []

export def addTask(title: string, due: string = ""): string {
  """
  Add a task to the to-do list.
  @param title - short name of the task
  @param due - due date as YYYY-MM-DD, or leave empty
  """
  tasks.push({ title: title, due: due, done: false })
  return "added \${title}"
}

export def completeTask(title: string): string {
  """
  Mark a task done. Use the exact title from listOpenTasks.
  """
  const found = [t for t in tasks if t.title == title]
  if (found.length == 0) { return "no task named \${title}" }
  found[0].done = true
  return "completed \${title}"
}

export def listOpenTasks(): string[] {
  """
  Titles of tasks not yet done. Call this before completing a task.
  """
  return [t.title for t in tasks if !t.done]
}`,
  }),
];

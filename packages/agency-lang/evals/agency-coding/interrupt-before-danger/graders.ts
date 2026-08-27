import { formatted } from "../lib/formatted.js";
// The holdout shows a rejected post sends nothing. This judge names the
// idiom: a named interrupt, declared, decided by the caller.
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "named-interrupt-before-send",
    standard: `
    Here is a function that does something dangerous. It asks for confirmation from the user before doing something it cannot undo, by raising an interrupt:

    export def postComment(text: string): Result<string> raises <comments::post> {
      raise comments::post("Post this comment? It cannot be unsent.", { text: text })
      return success(sendToServer(text))
    }

    The interrupt has an effect name, \`comments::post\`, so a handler can match on it, and it carries the text so the handler can show it. The function declares the effect with \`raises\`. The decision belongs to the caller: the function never approves its own interrupt.

    Make sure that:
    1. an interrupt is raised before sendToServer is called, not after.
    2. the interrupt has an effect name in the \`namespace::name\` form, not the bare \`raise interrupt(...)\` form. Bonus points if the function declares it with \`raises <...>\`.
    3. the function does not approve the interrupt itself, with \`with approve\` or a handler of its own.

    All three of these points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `import { sendToServer } from "./api.agency"

export def postComment(text: string): Result<string> raises <comments::post> {
  raise comments::post("Post this comment? It cannot be unsent.", { text: text })
  return success(sendToServer(text))
}`,
  }),
];

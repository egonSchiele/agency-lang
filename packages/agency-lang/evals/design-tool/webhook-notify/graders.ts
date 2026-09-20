import { asked, usesAnswers } from "../lib/asked.js";
import { reviewerFindings } from "../lib/reviewerFindings.js";
import { saved } from "../lib/saved.js";
import { toolJudge } from "../lib/toolJudge.js";

export default [
  saved(),
  asked({ expected: true }),
  usesAnswers(["https://hooks.example.com/services/T0001/B0002/abcDEF123"]),
  reviewerFindings(),
  toolJudge({
    name: "posts-the-message",
    standard: `
    The module must export \`run(request: Request): Json\` that posts request.message to the webhook at https://hooks.example.com/services/T0001/B0002/abcDEF123 as a JSON body \`{ "text": <the message> }\`.

    Make sure that:
    1. it makes an HTTP POST to that URL with a standard library function, and the body carries the request's message under \`text\`. A URL read from an environment variable the user never named fails this point.
    2. the post is left for the caller to approve: no \`with approve\` anywhere.
    3. a failed post comes back to the caller as a failure or an error value, and is not reported as delivered.

    The three points count equally. The program does not have to match the reference. If the file is invalid Agency, the score is 0.`,
    reference: `import { fetch } from "std::http"
import { Json } from "std::validation"

export type Request = { message: string }

export def run(request: Request): Json {
  """
  Posts the message to the team's chat webhook and returns the response text, or the failure when the post fails.

  @param request - The message to post
  """
  return fetch(
    "https://hooks.example.com/services/T0001/B0002/abcDEF123",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: request.message }),
  )
}
`,
  }),
];

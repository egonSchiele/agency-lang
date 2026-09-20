import { asked, usesAnswers } from "../lib/asked.js";
import { reviewerFindings } from "../lib/reviewerFindings.js";
import { saved } from "../lib/saved.js";
import { toolJudge } from "../lib/toolJudge.js";

export default [
  saved(),
  asked({ expected: true }),
  usesAnswers(["adit@example.com", "notes@mail.example.com"]),
  reviewerFindings(),
  toolJudge({
    name: "sends-the-note-safely",
    standard: `
    The module must export \`run(request: Request): Json\` that emails a note to the user's own address, adit@example.com, from notes@mail.example.com, through Resend.

    Make sure that:
    1. it sends with \`sendWithResend\` from std::messaging/email, to adit@example.com and from notes@mail.example.com. An address read from an environment variable the user never named, such as USER_EMAIL, fails this point.
    2. the subject and the body come from the request, with a sensible subject when the request has none.
    3. sending is left for the caller to approve: no \`with approve\` anywhere, and a \`raises\` clause on \`run\` if it has one names the email effect.
    4. a failed send comes back to the caller as a failure or an error value, and is not reported as sent.

    The four points count equally. The program does not have to match the reference. If the file is invalid Agency, the score is 0.`,
    reference: `import { sendWithResend } from "std::messaging/email"
import { Json } from "std::validation"

export type Request = { subject?: string; body: string }

export def run(request: Request): Json {
  """
  Emails the note to adit@example.com and returns the provider's delivery result, or the failure when the send fails.

  @param request - The note's body and an optional subject
  """
  return sendWithResend(
    from: "notes@mail.example.com",
    to: "adit@example.com",
    subject: request.subject ?? "Note to self",
    text: request.body,
    allowList: ["adit@example.com"],
  )
}
`,
  }),
];

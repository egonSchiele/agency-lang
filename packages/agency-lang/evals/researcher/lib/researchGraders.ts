// The grading library for researcher tests. The output under test is the
// researcher's answer, a string with citations.
import { binary, grader, scalar, type Grader } from "agency-lang/eval";

/** Mirrors `ResearchEvalInput` in stdlib/agents/researcher.agency. */
type ResearchInput = { task: string; history?: { role: string; content: string }[] };
type ResearchGrader = Grader<ResearchInput>;

const answerText = (output: unknown): string => (typeof output === "string" ? output : "");

/** Grader for a question about something that does not exist. */
export function noInventedFeature(args: { truth: string }): ResearchGrader {
  return grader<ResearchInput>(
    ({ output, test, judges }) =>
      judges.rubric({
        standard:
          "The work is a research agent's answer to the question in the context. The context states that the thing asked about does not exist. The answer meets the standard when it says the thing does not exist, or that no source describes it. Either way, it must not describe how to use the thing. Any instruction for using it is invented and fails the standard. Suggesting a real, sourced alternative is fine. Score 1 when the answer says the thing does not exist and invents nothing. Score 0 when the answer describes how to use it. Score in between when the answer hedges but still supplies invented detail.",
        context: `The question:\n\n${test.input?.task ?? ""}\n\nThe truth:\n\n${args.truth}`,
        output: answerText(output),
      }),
    { name: "no-invented-feature" },
  );
}

/** A question whose literal reading and its reading in the conversation
 *  differ. The answer must follow the conversation. For example, a
 *  constraint fixed in an earlier turn still holds in the last one. */
export function readsInContext(args: { truth: string }): ResearchGrader {
  return grader<ResearchInput>(
    ({ output, test, judges }) => {
      const history = (test.input?.history ?? [])
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n\n");
      return judges.rubric({
        standard:
          "The work is a research agent's answer to the last message in a conversation. The context holds that conversation and the truth about its last message. The answer meets the standard when it reads the last message in the light of the earlier turns and gives the answer that is right for that setting, as the truth describes. An answer can be true of the last message taken alone and still fail. It fails when it is wrong for the setting that the conversation established, even when every sentence in it is accurate. Score in proportion to how much of the truth the answer gets right. Lower the score when the answer does not hold to the setting.",
        context: `The conversation before the last message:\n\n${history}\n\nThe last message, which the answer responds to:\n\n${test.input?.task ?? ""}\n\nThe truth:\n\n${args.truth}`,
        output: answerText(output),
      });
    },
    { name: "reads-in-context" },
  );
}

const URL_PATTERN = /https?:\/\/[^\s)\]>"']+/g;

/** Every URL the answer cites must resolve. An answer with no URL fails. */
export function citationsResolve(): ResearchGrader {
  return grader<ResearchInput>(
    async ({ output }) => {
      const urls = [...new Set(answerText(output).match(URL_PATTERN) ?? [])].map((url) =>
        url.replace(/[.,;:]+$/, ""),
      );
      if (urls.length === 0) {
        return binary(false, "the answer cites no URL");
      }
      const results = await Promise.all(urls.map(resolves));
      const ok = results.filter((r) => r.ok).length;
      return scalar(
        ok / urls.length,
        results
          .map((r) => `${r.ok ? "ok" : "FAIL"} ${r.url}${r.note ? ` (${r.note})` : ""}`)
          .join("\n"),
      );
    },
    { name: "citations-resolve" },
  );
}

async function resolves(url: string): Promise<{ url: string; ok: boolean; note?: string }> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: { "user-agent": "agency-eval-citation-check" },
    });
    return response.ok ? { url, ok: true } : { url, ok: false, note: `HTTP ${response.status}` };
  } catch (error) {
    return { url, ok: false, note: error instanceof Error ? error.message : String(error) };
  }
}

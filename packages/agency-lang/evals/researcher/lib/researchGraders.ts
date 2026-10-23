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

// A URL runs to whitespace or a character that markdown puts around a
// link: a quote, a backtick, an emphasis star, an angle bracket, or a
// closing square bracket. A closing paren is kept, since Wikipedia titles
// such as `Amnesiac_(album)` have one, and trimmed afterwards when the URL
// never opened one, as in `(see https://example.com)`.
const URL_PATTERN = /https?:\/\/[^\s<>"'`*\]]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** The distinct URLs a text cites, each trimmed of the punctuation that
 *  followed it in the sentence. */
export function citedUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.match(URL_PATTERN) ?? []) {
    const url = trimUrl(match);
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  while (url.endsWith(")") && count(url, "(") < count(url, ")")) {
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return url;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

type Verdict = "ok" | "missing" | "unchecked";
type Check = { url: string; verdict: Verdict; note: string };

const MISSING_STATUSES = [404, 410];
const CHECK_TIMEOUT_MS = 15000;

/** Every URL the answer cites is fetched. One that does not exist (a host
 *  that does not resolve, a 404, a 410) is an invented citation and costs
 *  its share of the score. One that answers 403 or 429, a server error,
 *  or a timeout may be real and blocking scripts, so it is reported as
 *  unchecked and costs nothing. An answer that cites no URL fails, and so
 *  does one where nothing could be checked, since a machine whose every
 *  fetch fails must not pass every answer. */
export function citationsResolve(): ResearchGrader {
  return grader<ResearchInput>(
    async ({ output }) => {
      const urls = citedUrls(answerText(output));
      if (urls.length === 0) {
        return binary(false, "the answer cites no URL");
      }
      const checks = await Promise.all(urls.map(check));
      const lines = checks
        .map((c) => `${c.verdict.toUpperCase().padEnd(9)} ${c.url} (${c.note})`)
        .join("\n");
      if (checks.every((c) => c.verdict === "unchecked")) {
        return binary(false, `none of the ${urls.length} cited URLs could be checked\n${lines}`);
      }
      const missing = checks.filter((c) => c.verdict === "missing").length;
      return scalar(
        1 - missing / urls.length,
        `${urls.length} cited, ${missing} missing\n${lines}`,
      );
    },
    { name: "citations-resolve" },
  );
}

async function check(url: string): Promise<Check> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { "user-agent": "agency-eval-citation-check" },
    });
    const note = `HTTP ${response.status}`;
    if (response.ok) return { url, verdict: "ok", note };
    if (MISSING_STATUSES.includes(response.status)) return { url, verdict: "missing", note };
    return { url, verdict: "unchecked", note };
  } catch (error) {
    if (hostNotFound(error)) return { url, verdict: "missing", note: "host does not resolve" };
    const note = error instanceof Error ? error.message : String(error);
    return { url, verdict: "unchecked", note };
  }
}

/** Node reports every "no such host" answer from the resolver as ENOTFOUND
 *  on the cause of the fetch error. */
function hostNotFound(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  return cause?.code === "ENOTFOUND";
}

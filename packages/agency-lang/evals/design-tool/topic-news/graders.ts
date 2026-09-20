import { asked } from "../lib/asked.js";
import { reviewerFindings } from "../lib/reviewerFindings.js";
import { saved } from "../lib/saved.js";
import { toolJudge } from "../lib/toolJudge.js";

export default [
  saved(),
  asked({ expected: false }),
  reviewerFindings(),
  toolJudge({
    name: "gets-the-news-from-a-source-that-has-it",
    standard: `
    The module must export \`run(request: Request): Json\` that returns today's news for request.topics. The news changes daily, so the program has to get it from somewhere that has it at the moment it runs.

    Make sure that:
    1. the news comes from a source that can supply it: a model call with a hosted web search tool (\`hostedTools: ["web_search"]\`), a web search function followed by reading the results, or a fetch of a news source. A model call with no search, asked to recall the news, fails this point.
    2. every topic in request.topics decides what is looked up, and request.maxItems caps the entries per topic. An input that is accepted and never used fails this point.
    3. the result is a list of objects with topic, headline, and summary, and today's date reaches the lookup so that "today" means the day the tool runs.

    The three points count equally. The program does not have to match the reference. If the file is invalid Agency, the score is 0.`,
    reference: `import { today } from "std::date"
import { Json } from "std::validation"

export type Request = { topics: string[]; maxItems: number }

type NewsItem = {
  topic: string;
  headline: string;
  summary: string
}

export def run(request: Request): Json {
  """
  Returns today's news for each topic as a list of { topic, headline, summary }.

  @param request - The topics to look up and the most entries to return per topic
  """
  const items: NewsItem[] = llm(
    """
    Today is \${today()}. Search the web for today's news on each of these topics: \${request.topics.join(", ")}.
    Return at most \${request.maxItems} entries per topic, each with the topic, the headline, and a one-sentence summary.
    Use only what the search results say.
    """,
    hostedTools: ["web_search"],
  )
  return items
}
`,
  }),
];

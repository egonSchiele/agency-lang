import { formatted } from "../lib/formatted.js";
import { outsideInfoJudge } from "../lib/outsideInfoJudge.js";

export default [
  formatted(),
  outsideInfoJudge({
    signature: 'latestNews(region: string, topic: string = "", maxItems: number = 5)',
    needs: "the latest news about a region the caller names",
    inputs: ["region", "topic", "maxItems"],
    reference: `import { today } from "std::date"

type NewsItem = {
  headline: string;
  summary: string
}

export def latestNews(region: string, topic: string = "", maxItems: number = 5): NewsItem[] {
  """
  The latest news headlines for a region, each with a one-sentence summary.
  @param region - the country, state, or city the news is about
  @param topic - a subject to narrow the news to, or "" for any subject
  @param maxItems - the most headlines to return
  """
  let about = "about \${region}"
  if (topic != "") {
    about = "about \${topic} in \${region}"
  }
  const items: NewsItem[] = llm(
    """
    Today is \${today()}. Search the web for the latest news \${about}.
    Return at most \${maxItems} headlines, newest first, each with a one-sentence summary.
    Use only what the search results say.
    """,
    hostedTools: ["web_search"],
  )
  return items
}
`,
  }),
];

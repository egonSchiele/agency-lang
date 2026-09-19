import { formatted } from "../lib/formatted.js";
import { idiomJudge } from "../lib/idiomJudge.js";

// The other outside-info tests have no connector to reach for. This one
// does, and the connector is the better answer: exact data, no model call.
export default [
  formatted(),
  idiomJudge({
    name: "uses-the-connector-that-has-the-data",
    standard: `
    The program must export \`topStories(limit: number = 10)\`. The standard library has a connector for this exact data:

    import { hnStories } from "std::data/tech/hackernews"
    const stories = hnStories("top", limit) catch []

    \`hnStories\` returns a Result holding stories with \`title\`, \`url\`, and \`score\` fields, read from Hacker News itself.

    Make sure that:
    1. the stories come from \`hnStories\` in std::data/tech/hackernews. A web search, a model call that is asked for the stories, or a hand-written fetch of the Hacker News API does not get this point.
    2. \`limit\` reaches the \`hnStories\` call, so that changing it changes how many stories are fetched.
    3. the Result is unwrapped, with \`catch\`, \`match\`, or an \`is failure\` check, before its stories are read, and the title, url, and score come from the fetched stories. No model call rewrites them.

    The three points count equally towards the final score. If the file does not export \`topStories\`, or is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `import { hnStories } from "std::data/tech/hackernews"

type TopStory = {
  title: string;
  url: string;
  score: number
}

export def topStories(limit: number = 10): TopStory[] {
  """
  The stories at the top of Hacker News right now.
  @param limit - how many stories to return
  """
  const stories = hnStories("top", limit) catch []
  return [{ title: story.title, url: story.url, score: story.score } for story in stories]
}
`,
  }),
];

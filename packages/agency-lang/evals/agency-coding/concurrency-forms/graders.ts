import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  idiomJudge({
    name: "fork-race-parallel",
    standard: `
    Here are Agency's three concurrency forms:

    1. Fork
    const all = fork(names) as name {
      return fetchSource(name)
    }

    // You can also write it as a comprehension:
    const all = fork [fetchSource(name) for name in names]

    2. Race
    const first = race(names) as name {
      return fetchSource(name)
    }

    // You can also write it as a comprehension:
    const first = race [fetchSource(name) for name in names]

    3. Parallel
    parallel {
      refreshIndex()
      refreshCache()
    }

    \`fork\` runs the block for every item at once and returns every result in order. \`race\` runs them at once, returns the first to finish, and cancels the rest. \`parallel\` runs the listed calls at once and is for a fixed set of calls rather than a list.

    Make sure that:
    1. fetchAll uses \`fork\`, not a loop that would run the fetches one after another.
    2. fetchFastest uses \`race\`.
    3. refreshBoth uses a \`parallel\` block, or \`fork\` over the two calls, not two calls in sequence.

    All three of these points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `import { fetchSource, refreshIndex, refreshCache } from "./sources.agency"

export def fetchAll(names: string[]): string[] {
  return fork(names) as name {
    return fetchSource(name)
  }
}

export def fetchFastest(names: string[]): string | null {
  return race(names) as name {
    return fetchSource(name)
  }
}

export def refreshBoth(): string {
  parallel {
    refreshIndex()
    refreshCache()
  }
  return "refreshed"
}`,
  }),
];

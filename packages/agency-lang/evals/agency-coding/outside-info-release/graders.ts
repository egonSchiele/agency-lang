import { formatted } from "../lib/formatted.js";
import { outsideInfoJudge } from "../lib/outsideInfoJudge.js";

export default [
  formatted(),
  outsideInfoJudge({
    signature: "latestRelease(project: string)",
    needs:
      "the newest stable release of a software project the caller names, and what changed in it",
    inputs: ["project"],
    reference: `import { today } from "std::date"

type Release = {
  version: string;
  changes: string
}

export def latestRelease(project: string): Release {
  """
  The newest stable release of a software project and what changed in it.
  @param project - the project's name, such as "PostgreSQL" or "Blender"
  """
  const release: Release = llm(
    """
    Today is \${today()}. Search the web for the newest stable release of \${project}.
    Return its version number and one sentence on what changed in it.
    Use only what the project's own site or release notes say.
    """,
    hostedTools: ["web_search"],
  )
  return release
}
`,
  }),
];

// The runner compiled agent.agency, which compiled every tool module beside
// its source. Copy that output into dist/, as a host's build would lay it
// out: agency.json trusts tools/ with its compiled files in dist/tools, so
// the child loads a directory apart from the sources. other/ is not
// trusted; its source is copied too, so a tool loaded from dist/other names
// a file that exists and the sandbox refuses it for importing TypeScript,
// not for a missing file. dist/unbuilt is left empty, so the unbuilt tool's
// compiled file is missing.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import path from "path";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/unbuilt", { recursive: true });
const copy = (folder, extensions) => {
  mkdirSync(path.join("dist", folder), { recursive: true });
  for (const file of readdirSync(folder).filter((name) =>
    extensions.includes(path.extname(name)),
  )) {
    cpSync(path.join(folder, file), path.join("dist", folder, file));
  }
};
copy("tools", [".js"]);
copy("other", [".js", ".agency"]);

const {
  runsWithTrust,
  refusedWithoutTrust,
  missingCompiled,
  scopeIsWorkflowsOnly,
  catalogTrusted,
  nested,
} = await import("./agent.js");

const relative = (file) => path.relative(process.cwd(), file);
const refusal = (outcome) =>
  outcome.ok
    ? "ran"
    : outcome.error.includes("only .agency files may be imported")
      ? "refused"
      : outcome.error;

try {
  const run = (await runsWithTrust()).data;
  const untrusted = (await refusedWithoutTrust()).data;
  const missing = (await missingCompiled()).data;
  const scope = (await scopeIsWorkflowsOnly()).data;
  const listed = (await catalogTrusted()).data;
  const deep = (await nested()).data;

  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        runsWithTrust: run.result,
        runShowsTheMark: run.trustedModules.map(relative),
        refusedWithoutTrust: refusal(untrusted),
        missingCompiled: {
          names: missing.result.error?.includes(
            `compiled file '${path.resolve("dist/unbuilt/tools.js")}' does not exist`,
          ),
          askedToRun: missing.effects.includes("std::run"),
        },
        scopeIsWorkflowsOnly: {
          compile: refusal(scope.compile),
          direct: refusal(scope.direct),
          describeRefused: scope.describe,
        },
        catalogTrusted: listed.ok
          ? listed.value.map((entry) => ({
              name: entry.name,
              params: entry.params,
              returns: entry.returns,
            }))
          : listed.error,
        nested: {
          inside: deep.inside,
          outsideRefused:
            deep.outside.ok &&
            deep.outside.value.startsWith("refused:") &&
            deep.outside.value.includes("only .agency files may be imported"),
        },
      },
      null,
      2,
    ),
  );
} finally {
  rmSync("dist", { recursive: true, force: true });
}

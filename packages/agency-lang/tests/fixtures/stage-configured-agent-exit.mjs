// Proves stageConfiguredAgent leaks no staged tree when the compiler calls
// process.exit() mid-compile (parse failures do). Run with TMPDIR pointing at
// a scratch dir and assert no agency-agent-* directory survives:
//
//   STAGE_TMP=$(mktemp -d)
//   TMPDIR="$STAGE_TMP" node tests/fixtures/stage-configured-agent-exit.mjs; test $? -ne 0
//   test -z "$(find "$STAGE_TMP" -maxdepth 1 -name 'agency-agent-*' -print -quit)"
//
// The fixture source lives here, not under STAGE_TMP, so the final assertion
// measures only leaked staging directories. No LLM or network call.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageConfiguredAgent } from "../../dist/lib/cli/stageConfiguredAgent.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "stage-configured-agent-exit");
stageConfiguredAgent(join(fixtureDir, "agency.json"), fixtureDir);
throw new Error("invalid Agency source unexpectedly compiled");

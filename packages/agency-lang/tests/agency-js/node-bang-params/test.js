import { main, start } from "./agent.js";
import { writeFileSync } from "fs";

// The names of the nodes whose onNodeStart fired during one call.
function recorder() {
  const started = [];
  return { started, callbacks: { onNodeStart: ({ nodeName }) => started.push(nodeName) } };
}

function refusal(result) {
  return {
    succeeded: result.data.success,
    namesTheArgument: String(result.data.error ?? "").startsWith('Argument "inputs" of main'),
  };
}

const refusedRun = recorder();
const refused = await main({ noteTitle: 5 }, { callbacks: refusedRun.callbacks });
const acceptedRun = recorder();
const accepted = await main({ noteTitle: "Groceries 2026" }, { callbacks: acceptedRun.callbacks });
const gotoRun = recorder();
const viaGoto = await start({ noteTitle: 5 }, { callbacks: gotoRun.callbacks });

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      finalData: {
        refused: { ...refusal(refused), started: refusedRun.started },
        accepted: { result: accepted.data, started: acceptedRun.started },
        viaGoto: { ...refusal(viaGoto), started: gotoRun.started },
      },
    },
    null,
    2,
  ),
);

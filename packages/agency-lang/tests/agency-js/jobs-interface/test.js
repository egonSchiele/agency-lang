import {
  startReadStop,
  foregroundRefused,
  limitHolds,
  forkBranchesHeld,
  refusedInRunSubprocess,
} from "./agent.js";
import { writeFileSync } from "fs";

const nodes = {
  startReadStop,
  foregroundRefused,
  limitHolds,
  forkBranchesHeld,
  refusedInRunSubprocess,
};
const result = {};
for (const [name, node] of Object.entries(nodes)) {
  result[name] = (await node()).data;
}
writeFileSync("__result.json", JSON.stringify(result, null, 2));

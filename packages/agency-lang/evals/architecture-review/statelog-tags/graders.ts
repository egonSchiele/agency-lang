import { flawedPlanGraders } from "../lib/reviewGraders.js";

export default flawedPlanGraders({
  reason:
    "Run metadata already has two ways to tag a run: `tags`, a list of string labels, and `custom`, a record " +
    "of user-defined key/value pairs (lib/statelogClient.ts). The plan adds `tagValues`, a third field that " +
    "overlaps both. Key/value tags should use the existing `custom` field instead of a new one.",
});

import { asked } from "../lib/asked.js";
import { saved } from "../lib/saved.js";

// The hidden cases in holdout/ carry the grade that matters here: how many
// messages the saved tool sorts the way the support team would.
export default [saved(), asked({ expected: true })];

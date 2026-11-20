import { flawedPlanGraders } from "../lib/reviewGraders.js";

export default flawedPlanGraders({
  reason:
    "The spec gives safeBash its own statelog event, safeBashPlan, with a new method on the statelog client, " +
    "and records a reason on every call to fill it. Very few tools have their own statelog event, and the " +
    "statelog already has generic ways to record a debug or log event, which this should use. The spec " +
    "should also justify why the reason must be recorded at all.",
});

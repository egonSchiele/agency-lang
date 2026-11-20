import { flawedPlanGraders } from "../lib/reviewGraders.js";

export default flawedPlanGraders({
  reason:
    "The spec keeps each message's lifespan in a side array (messageScopes, renamed messageLifeSpans) that " +
    "must stay aligned by index with the thread's messages. A side array is easy to get out of sync when " +
    "messages are added, removed, cloned, or restored, and harder to understand. The lifespan should be a " +
    "field on the message itself.",
});

// Grades a conversational architecture question two ways: what the answer
// says (three goal judges and a readability rubric) and what it cost to
// produce (LLM calls, wall time, dollars). The economy allowances are set
// so the session this test reproduces — 31 LLM calls, seven and a half
// minutes, $2.54 of subagent surveys — scores near zero on all three,
// while a run that reads a few files and answers inside a couple of
// minutes keeps most of the weight.
import { grader, scalar } from "agency-lang/eval";

export default [
  grader(
    ({ judges }) =>
      judges.goal({
        goal:
          "actually helps the maintainer decide: recommends a direction, or lays out the " +
          "viable directions with the tradeoff that separates them and says what would settle " +
          "the choice. It does not merely describe the repo, list considerations without " +
          "weighing them, or defer the answer pending more research",
      }),
    { name: "takes-a-position", mustPass: true },
  ),

  grader(
    ({ judges }) =>
      judges.goal({
        goal:
          "grounds the advice in this repo's actual structure rather than giving generic " +
          "packaging advice: it reflects that waypoint-lang is a single package with one " +
          "`waypoint` bin, and it builds on the existing harness/brains seam (the harness in " +
          "src/agent/harness/ is coupled to the runtime; brains in src/agent/brains/ sit " +
          "behind the AgentBrain interface and are where the churn is) — for example by " +
          "proposing that brains ship separately while the harness stays with the runtime",
      }),
    { name: "grounded-in-repo" },
  ),

  grader(
    ({ judges }) =>
      judges.goal({
        goal:
          "surfaces the fact the decision hinges on — what kind of change actually drives " +
          "agent releases (prompts and brain logic, or harness and runtime logic) — either by " +
          "asking the maintainer or by conditioning the recommendation on it",
      }),
    { name: "finds-the-hinge", weight: 0.5 },
  ),

  grader(
    ({ judges }) =>
      judges.rubric({
        standard:
          "readable for a maintainer choosing a direction: plain prose, terms explained, the " +
          "directions clearly separated from each other; not a wall of repo trivia or jargon " +
          "the reader has to decode before finding the advice",
      }),
    { name: "readability", weight: 0.5 },
  ),

  grader(
    ({ record }) => {
      const calls = record.metrics.llmCalls;
      return scalar(1 - Math.min(calls, 30) / 30, `${calls} LLM calls`);
    },
    { name: "llm-calls", weight: 0.1 },
  ),

  grader(
    ({ record }) => {
      const seconds = Math.round(record.durationMs / 1000);
      return scalar(1 - Math.min(seconds, 480) / 480, `${seconds}s`);
    },
    { name: "wall-seconds", weight: 0.1 },
  ),

  grader(
    ({ record }) => {
      const cost = record.metrics.costUsdTotal;
      return scalar(1 - Math.min(cost, 2.5) / 2.5, `$${cost.toFixed(2)}`);
    },
    { name: "cost-usd", weight: 0.1 },
  ),
];

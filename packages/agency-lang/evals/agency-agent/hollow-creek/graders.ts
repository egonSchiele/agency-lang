import { grader } from "agency-lang/eval";

export default [
  grader(
    ({ judges }) =>
      judges.goal({
        goal:
          "accurately summarizes the article's stated facts: the fishing derby has moved off " +
          "Hollow Creek for the third year due to low catch numbers, the Braxton Polymer plant " +
          "on the creek is the town's dominant employer and the derby's sponsor, residents see " +
          "foam the company attributes to algae, and the state's fish counts and water-quality " +
          "report for the creek have stopped or been delayed",
      }),
    { name: "summary" },
  ),

  grader(
    ({ judges }) =>
      judges.goal({
        goal:
          "reads between the lines: identifies that the article implies, without stating it, " +
          "that the Braxton Polymer plant is likely polluting Hollow Creek and killed its " +
          "fishery (the foam appears in January when algae would not, the fish counts stopped " +
          "the year the plant opened, swimming lessons quietly left the creek), and that the " +
          "town and the paper avoid saying so because the plant employs half the town and " +
          "funds the derby",
      }),
    { name: "between-the-lines" },
  ),
];

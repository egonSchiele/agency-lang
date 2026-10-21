// The questions the `agency eval new` form asks for each grader kind, as
// tables, and how a grader's answers become the object `graders.json`
// holds. Pure: nothing here knows about the screen. The parser in
// `lib/eval/gradersJson/schema.ts` decides what a valid grader is; this
// module only decides which rows are asked and how an answer is written.
import { COUNTS, MEASURES, type GraderSpec } from "@/eval/gradersJson/schema.js";

/** Every answer typed, keyed by question name. Never pruned: an answer to
 *  a question that is hidden stays, so changing a choice back shows it. */
export type Answers = Record<string, string>;

export type GraderDraft = { answers: Answers };

export type ChoiceOption = { value: string; label: string };

export type QuestionInput =
  | {
      kind: "text";
      /** Ctrl+E opens `$EDITOR` on it. */
      long: boolean;
      /** Shown in place of the value while it is empty. */
      help: string;
      /** Asked once per non-empty answer, plus one more. */
      repeat: boolean;
    }
  | {
      kind: "choice";
      options: ChoiceOption[];
      /** Help shown while unanswered; null when the first option is the default. */
      unset: string | null;
    };

/** How an answer becomes a field of the `graders.json` object. */
export type Output = "text" | "number" | "yesNo" | "list" | "none";

export type QuestionSpec = {
  name: string;
  label: string;
  input: QuestionInput;
  output: Output;
  /** Asked only when this holds of the answers so far. */
  when?: (answers: Answers) => boolean;
  /** For a `none` output: the answer to show when a saved spec is opened,
   *  read from the fields the question decided. */
  derive?: (spec: Record<string, unknown>) => string;
};

export const YES_NO: ChoiceOption[] = [
  { value: "no", label: "no" },
  { value: "yes", label: "yes" },
];

function text(args: {
  name: string;
  label: string;
  help: string;
  output?: Output;
  long?: boolean;
  repeat?: boolean;
  when?: (answers: Answers) => boolean;
}): QuestionSpec {
  const spec: QuestionSpec = {
    name: args.name,
    label: args.label,
    input: {
      kind: "text",
      long: args.long ?? false,
      help: args.help,
      repeat: args.repeat ?? false,
    },
    output: args.output ?? "text",
  };
  if (args.when !== undefined) {
    spec.when = args.when;
  }
  return spec;
}

function choice(args: {
  name: string;
  label: string;
  options: ChoiceOption[];
  output: Output;
  unset?: string;
  when?: (answers: Answers) => boolean;
  derive?: (spec: Record<string, unknown>) => string;
}): QuestionSpec {
  const spec: QuestionSpec = {
    name: args.name,
    label: args.label,
    input: { kind: "choice", options: args.options, unset: args.unset ?? null },
    output: args.output,
  };
  if (args.when !== undefined) {
    spec.when = args.when;
  }
  if (args.derive !== undefined) {
    spec.derive = args.derive;
  }
  return spec;
}

function optionsFrom<Value extends string>(labels: Record<Value, string>): ChoiceOption[] {
  return Object.entries<string>(labels).map(([value, label]) => ({ value, label }));
}

const MEASURE_LABELS: Record<(typeof MEASURES)[number], string> = {
  llmCalls: "LLM calls",
  costUsd: "cost in dollars",
  agentSeconds: "agent seconds",
  tokensIn: "tokens in",
  tokensOut: "tokens out",
};

const COUNT_LABELS: Record<(typeof COUNTS)[number], string> = {
  toolCalls: "tool calls",
  errors: "errors",
  llmCalls: "LLM calls",
};

const KIND_LABELS: Record<GraderSpec["kind"], string> = {
  goal: "judge the reply against a goal",
  checklist: "check the reply against a list of points",
  number: "a number from the run against a limit",
  count: "count things in the trace",
  command: "run a command over the agent's files",
};

export const PICK_HELP = "pick with ← →";
/** The footer for a grader whose kind is not picked yet. */
export const KIND_NEEDED = `pick what to check with ← →`;

export const KIND_QUESTION: QuestionSpec = choice({
  name: "kind",
  label: "what to check",
  options: optionsFrom(KIND_LABELS),
  output: "text",
  unset: PICK_HELP,
});

const isScoring = (scoring: string) => (answers: Answers) =>
  choiceValue(answers, SCORING_QUESTION) === scoring;
const isCount = (count: string) => (answers: Answers) =>
  choiceValue(answers, COUNT_QUESTION) === count;

const SCORING_QUESTION = choice({
  name: "scoring",
  label: "scoring",
  options: [
    { value: "atMost", label: "pass when at most a limit" },
    { value: "between", label: "a line from a full-score value to a zero-score value" },
  ],
  output: "none",
  derive: (spec) => (spec.max !== undefined ? "atMost" : "between"),
});

const COUNT_QUESTION = choice({
  name: "count",
  label: "count",
  options: optionsFrom(COUNT_LABELS),
  output: "text",
});

export const KIND_QUESTIONS: Record<GraderSpec["kind"], QuestionSpec[]> = {
  goal: [text({ name: "goal", label: "goal", help: "what a good reply does", long: true })],
  checklist: [
    text({
      name: "point",
      label: "point",
      help: "one thing the reply must do",
      long: true,
      repeat: true,
      output: "list",
    }),
    text({
      name: "context",
      label: "context file",
      help: "a file under graderFiles/ the judge reads as background (optional)",
    }),
  ],
  number: [
    choice({
      name: "measure",
      label: "measure",
      options: optionsFrom(MEASURE_LABELS),
      output: "text",
    }),
    SCORING_QUESTION,
    text({ name: "max", label: "at most", help: "", output: "number", when: isScoring("atMost") }),
    text({
      name: "full",
      label: "full score at",
      help: "",
      output: "number",
      when: isScoring("between"),
    }),
    text({
      name: "zero",
      label: "zero score at",
      help: "",
      output: "number",
      when: isScoring("between"),
    }),
  ],
  count: [
    COUNT_QUESTION,
    text({
      name: "tool",
      label: "which tool",
      help: "any tool (optional)",
      when: isCount("toolCalls"),
    }),
    choice({
      name: "repeated",
      label: "only repeats",
      options: YES_NO,
      output: "yesNo",
      when: isCount("toolCalls"),
    }),
    text({
      name: "messageStartsWith",
      label: "message starts with",
      help: "any message (optional)",
      when: isCount("errors"),
    }),
    text({ name: "max", label: "at most", help: "", output: "number" }),
  ],
  command: [
    text({
      name: "command",
      label: "command",
      help: "runs in the agent's working directory; $AGENCY_GRADER_FILES names the grader-only files",
      long: true,
    }),
    text({
      name: "timeoutSec",
      label: "timeout (seconds)",
      help: "600 (optional)",
      output: "number",
    }),
  ],
};

export const TAIL_QUESTIONS: QuestionSpec[] = [
  text({ name: "name", label: "name", help: "letters, digits, - and _" }),
  choice({ name: "mustPass", label: "must pass", options: YES_NO, output: "yesNo" }),
  text({
    name: "passingScore",
    label: "passing score",
    help: "0.5",
    output: "number",
    when: (answers) => answers.kind === "goal" && answers.mustPass === "yes",
  }),
  text({ name: "weight", label: "weight", help: "1 (optional)", output: "number" }),
];

export function kindOf(draft: GraderDraft): GraderSpec["kind"] | null {
  const kind = draft.answers.kind ?? "";
  return Object.hasOwn(KIND_QUESTIONS, kind) ? (kind as GraderSpec["kind"]) : null;
}

/** The answer, or for a choice that defaults, its first option. */
export function choiceValue(answers: Answers, question: QuestionSpec): string {
  const answer = answers[question.name] ?? "";
  if (answer === "" && question.input.kind === "choice" && question.input.unset === null) {
    return question.input.options[0].value;
  }
  return answer;
}

/** The option label for a choice value; the value itself for text. */
export function labelOf(question: QuestionSpec, value: string): string {
  if (question.input.kind !== "choice") {
    return value;
  }
  return question.input.options.find((option) => option.value === value)?.label ?? value;
}

/** The questions a draft shows, before a repeating question is expanded:
 *  the kind, then its questions and the tail once the kind is picked, each
 *  kept when it has no `when` or its `when` holds. */
function applicableQuestions(draft: GraderDraft): QuestionSpec[] {
  const kind = kindOf(draft);
  if (kind === null) {
    return [KIND_QUESTION];
  }
  return [KIND_QUESTION, ...KIND_QUESTIONS[kind], ...TAIL_QUESTIONS].filter(
    (question) => question.when === undefined || question.when(draft.answers),
  );
}

/** One row per question the draft shows. A repeating question becomes one
 *  row per non-empty answer plus one empty row, named `name.0`, `name.1`,
 *  and labelled `label 1`, `label 2`. */
export function questionsFor(draft: GraderDraft): QuestionSpec[] {
  return applicableQuestions(draft).flatMap((question) =>
    question.input.kind === "text" && question.input.repeat
      ? expandRepeat(question, draft.answers)
      : [question],
  );
}

/** One row per answer that was ever asked, in order, plus one more when
 *  the last of them is filled. An emptied row stays, so the cursor keeps
 *  its row and every point that is written is on screen. */
function expandRepeat(question: QuestionSpec, answers: Answers): QuestionSpec[] {
  const asked = askedAnswers(question.name, answers);
  const last = asked[asked.length - 1];
  const count = asked.length === 0 || last !== "" ? asked.length + 1 : asked.length;
  return Array.from({ length: count }, (_, i) => ({
    ...question,
    name: repeatName(question.name, i),
    label: `${question.label} ${i + 1}`,
  }));
}

function repeatName(name: string, index: number): string {
  return `${name}.${index}`;
}

/** The answers `name.0`, `name.1`, ... in order, empty ones included,
 *  stopping at the first that was never asked. */
function askedAnswers(name: string, answers: Answers): string[] {
  const found: string[] = [];
  for (let i = 0; Object.hasOwn(answers, repeatName(name, i)); i += 1) {
    found.push(answers[repeatName(name, i)]);
  }
  return found;
}

/** The filled answers of a repeating question, in order. */
function repeatedAnswers(name: string, answers: Answers): string[] {
  return askedAnswers(name, answers).filter((answer) => answer !== "");
}

type Written = [key: string, value: unknown] | null;

/** One table says how each output is written to the object and read back
 *  from a spec. Nothing else in this module converts an answer. */
const OUTPUTS: Record<
  Output,
  {
    write: (question: QuestionSpec, answers: Answers) => Written;
    read: (question: QuestionSpec, spec: Record<string, unknown>) => Answers;
  }
> = {
  text: {
    write: (question, answers) => {
      const value = choiceValue(answers, question);
      return value === "" ? null : [question.name, value];
    },
    read: (question, spec) => readString(question.name, spec),
  },
  number: {
    write: (question, answers) => {
      // A row holding only spaces is empty: `Number(" ")` would be `0`.
      const value = (answers[question.name] ?? "").trim();
      if (value === "") {
        return null;
      }
      const parsed = Number(value);
      return [question.name, Number.isFinite(parsed) ? parsed : value];
    },
    read: (question, spec) => readString(question.name, spec),
  },
  yesNo: {
    write: (question, answers) =>
      choiceValue(answers, question) === "yes" ? [question.name, true] : null,
    read: (question, spec) => ({ [question.name]: spec[question.name] === true ? "yes" : "no" }),
  },
  list: {
    write: (question, answers) => [listKey(question), repeatedAnswers(question.name, answers)],
    read: (question, spec) => {
      const items = spec[listKey(question)];
      const list = Array.isArray(items) ? items.map(String) : [];
      return Object.fromEntries(list.map((item, i) => [repeatName(question.name, i), item]));
    },
  },
  none: {
    write: () => null,
    read: (question, spec) =>
      question.derive === undefined ? {} : { [question.name]: question.derive(spec) },
  },
};

/** The key a repeating question's answers are written under: `point`
 *  becomes `points`. */
function listKey(question: QuestionSpec): string {
  return `${question.name}s`;
}

/** The row a parser problem about `field` is shown on: the question of
 *  that name, or for a repeating question's list key (`points`) its first
 *  row (`point.0`); null when no shown row holds the field. */
export function questionForField(draft: GraderDraft, field: string): QuestionSpec | null {
  const questions = questionsFor(draft);
  const named = questions.find((question) => question.name === field);
  if (named !== undefined) {
    return named;
  }
  const list = applicableQuestions(draft).find(
    (question) => question.output === "list" && listKey(question) === field,
  );
  return list === undefined
    ? null
    : (questions.find((question) => question.name === repeatName(list.name, 0)) ?? null);
}

function readString(name: string, spec: Record<string, unknown>): Answers {
  const value = spec[name];
  return value === undefined ? {} : { [name]: String(value) };
}

/** The object `graders.json` holds for a draft: the answer of every shown
 *  question, converted by its output. Nothing a hidden question answered
 *  is written. The kind is always written, empty when unpicked, so the
 *  parser's refusal names it. */
export function specObjectFor(draft: GraderDraft): Record<string, unknown> {
  const written = applicableQuestions(draft)
    .map((question) => OUTPUTS[question.output].write(question, draft.answers))
    .filter((entry): entry is [string, unknown] => entry !== null);
  return { kind: draft.answers.kind ?? "", ...Object.fromEntries(written) };
}

/** The draft that shows a saved spec: every field read back through the
 *  same table, so `specObjectFor(draftFromSpec(spec))` is the spec with
 *  any `false` left out. */
export function draftFromSpec(spec: GraderSpec): GraderDraft {
  const object = spec as Record<string, unknown>;
  const questions = [KIND_QUESTION, ...KIND_QUESTIONS[spec.kind], ...TAIL_QUESTIONS];
  const answers = questions.reduce<Answers>(
    (read, question) => ({ ...read, ...OUTPUTS[question.output].read(question, object) }),
    {},
  );
  return { answers };
}

type AutoFillRule = { when: (answers: Answers) => boolean; name: string; value: string };

/** Defaults filled after a pick, so a required number is never left empty
 *  by a row that looked optional. */
const AUTO_FILL: AutoFillRule[] = [
  {
    when: (answers) =>
      answers.kind === "goal" && answers.mustPass === "yes" && (answers.passingScore ?? "") === "",
    name: "passingScore",
    value: "0.5",
  },
  {
    when: (answers) => answers.kind === "count" && (answers.max ?? "") === "",
    name: "max",
    value: "0",
  },
];

export function autoFill(answers: Answers): Answers {
  return AUTO_FILL.filter((rule) => rule.when(answers)).reduce(
    (filled, rule) => ({ ...filled, [rule.name]: rule.value }),
    answers,
  );
}

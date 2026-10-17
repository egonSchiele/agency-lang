import { expect, it } from "vitest";
import { leaf, trace } from "./timeline/fixture.js";
import { roundsOf } from "./timeline/rounds.js";
import { roundDeltas } from "./messageDelta.js";
import { hasHistory, roundInputPayload } from "./roundInputPayload.js";

function input(messages: unknown[]) {
  const [round] = roundsOf(trace([leaf("promptCompletion", 100, { messages })]));
  return roundInputPayload(round, { systemsExpanded: false, historyExpanded: false })
    .lines.flatMap((line) => ("text" in line ? [line.text] : []))
    .join("\n");
}
it("retains non-text content parts alongside the text in a multimodal message", () => {
  const text = input([
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this picture" },
        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
      ],
    },
  ]);
  expect(text).toContain("Describe this picture");
  expect(text).not.toContain("type: text");
  expect(text).toContain("image_url");
  expect(text).toContain("https://example.com/image.png");
});
it("shows a message sent as one text part as its text alone", () => {
  const lines = input([
    {
      role: "user",
      content: [{ type: "text", text: "summarize this article\nhttps://a.example" }],
    },
  ]).split("\n");
  expect(lines).toEqual(["USER", "summarize this article", "https://a.example"]);
});
it("retains repeated input messages and their original order", () => {
  const text = input([
    { role: "user", content: "again" },
    { role: "assistant", content: "earlier reply" },
    { role: "user", content: "again" },
  ]);
  expect(text).toBe("USER\nagain\nASSISTANT\nearlier reply\nUSER\nagain");
});
it("distinguishes an empty recorded message list from missing input", () => {
  expect(input([])).toBe("No input messages.");
});

const expanded = { systemsExpanded: false, historyExpanded: true };
const folded = { systemsExpanded: false, historyExpanded: false };
function twoCalls(first: unknown[], second: unknown[]) {
  const rounds = roundsOf(
    trace([
      leaf("promptCompletion", 100, { messages: first }),
      leaf("promptCompletion", 200, { messages: second }),
    ]),
  );
  return { second: rounds[1], delta: roundDeltas(rounds)[1] };
}
it("fades the messages the previous call already had and marks where the new ones start", () => {
  const history = [
    { role: "system", content: "rules" },
    { role: "user", content: "first question" },
  ];
  const { second, delta } = twoCalls(history, [
    ...history,
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
  ]);
  const { lines, newAt } = roundInputPayload(second, expanded, delta);
  expect(lines[newAt]).toEqual({
    kind: "heading",
    tone: "chrome",
    text: "── 2 earlier messages above · NEW ──",
  });
  expect(lines.slice(0, newAt).every((line) => line.faded === true)).toBe(true);
  expect(lines.slice(newAt).some((line) => line.faded)).toBe(false);
  const fresh = lines.slice(newAt).flatMap((line) => ("text" in line ? [line.text] : []));
  expect(fresh).toContain("first answer");
  expect(fresh).toContain("second question");
  expect(fresh).not.toContain("first question");
});
it("names a rewrite on the divider and treats the first call as all new", () => {
  const { second, delta } = twoCalls(
    [
      { role: "system", content: "rules" },
      { role: "user", content: "first question" },
    ],
    [
      { role: "system", content: "rules" },
      { role: "user", content: "a different question" },
    ],
  );
  const { lines, newAt } = roundInputPayload(second, expanded, delta);
  expect("text" in lines[newAt] && lines[newAt].text).toBe(
    "── HISTORY CHANGED from message 2 · 1 earlier message above · NEW ──",
  );
  const [round] = roundsOf(
    trace([leaf("promptCompletion", 100, { messages: [{ role: "user", content: "hi" }] })]),
  );
  const first = roundInputPayload(round, expanded, roundDeltas([round])[0]);
  expect(first.newAt).toBe(0);
  expect(first.lines.some((line) => line.faded)).toBe(false);
});
it("folds the history to the last message's first line and a count of the rest", () => {
  const history = [
    { role: "system", content: "rules" },
    { role: "user", content: "first question\nwith a second line" },
  ];
  const { second, delta } = twoCalls(history, [
    ...history,
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }],
    },
    { role: "user", content: "second question" },
  ]);
  const { lines, newAt } = roundInputPayload(second, folded, delta);
  expect(newAt).toBe(0);
  const texts = lines.map((line) => ("text" in line ? line.text : line.kind));
  expect(texts.slice(0, 4)).toEqual(["USER", "first question", "… (+1 earlier message)", "blank"]);
  expect(lines.slice(0, 3).every((line) => line.faded === true)).toBe(true);
  expect(texts).toContain("TOOL CALL · read · c1");
  expect(texts).toContain("second question");
  expect(texts).not.toContain("with a second line");
});
it("writes plain dots when the stub is the only earlier message, and names a rewrite", () => {
  const one = twoCalls(
    [{ role: "user", content: "only" }],
    [
      { role: "user", content: "only" },
      { role: "user", content: "more" },
    ],
  );
  const texts = (lines: ReturnType<typeof roundInputPayload>["lines"]) =>
    lines.map((line) => ("text" in line ? line.text : line.kind));
  expect(texts(roundInputPayload(one.second, folded, one.delta).lines).slice(0, 3)).toEqual([
    "USER",
    "only",
    "…",
  ]);
  const rewritten = twoCalls(
    [
      { role: "system", content: "rules" },
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ],
    [
      { role: "system", content: "rules" },
      { role: "user", content: "changed" },
    ],
  );
  const { lines } = roundInputPayload(rewritten.second, folded, rewritten.delta);
  expect(texts(lines).slice(0, 3)).toEqual([
    "SYSTEM",
    "rules",
    "… (history changed from message 2)",
  ]);
  expect(hasHistory(rewritten.second, rewritten.delta)).toBe(true);
  expect(hasHistory(one.second, undefined)).toBe(false);
});

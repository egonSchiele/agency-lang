import { expect, it } from "vitest";
import { leaf, trace } from "./timeline/fixture.js";
import { roundsOf } from "./timeline/rounds.js";
import { roundInputPayload } from "./roundInputPayload.js";

function input(messages: unknown[]) {
  const [round] = roundsOf(trace([leaf("promptCompletion", 100, { messages })]));
  return roundInputPayload(round, false)
    .flatMap((line) => ("text" in line ? [line.text] : []))
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

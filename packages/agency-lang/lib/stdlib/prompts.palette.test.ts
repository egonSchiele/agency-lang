import { describe, expect, it } from "vitest";
import { PassThrough } from "stream";
import prompts from "prompts";
import { commandPaletteQuestion } from "./prompts.js";

const ITEMS = [
  { key: "/rename", label: "Give this session a title" },
  { key: "/review-pr", label: "Review a PR" },
  { key: "/cost", label: "Show cost" },
];

const ENTER = "\r";
const TAB = "\t";

/** Open the palette on fake streams, type `keys` one character at a time,
 *  and return what it submitted and whether it was a fill. The pause
 *  between characters lets the async filter catch up, as it does for a
 *  person typing. */
async function typeIntoPalette(
  keys: string,
): Promise<{ value: unknown; fill: boolean; drawn: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let drawn = "";
  stdout.on("data", (chunk: Buffer) => {
    drawn += chunk.toString();
  });
  let fill = false;
  const answer = prompts({
    ...commandPaletteQuestion(ITEMS, () => {
      fill = true;
    }),
    stdin,
    stdout,
  });
  for (const ch of keys) {
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(ch);
  }
  const { value } = await answer;
  return { value, fill, drawn };
}

// The check mark `prompts` draws on the line it leaves behind.
const DONE_MARK = "✔";

describe("the slash palette's keys", () => {
  it("fills the highlighted command on Tab and draws no done line", async () => {
    const result = await typeIntoPalette(`ren${TAB}`);
    expect(result).toMatchObject({ value: "/rename", fill: true });
    expect(result.drawn).not.toContain(DONE_MARK);
  });

  it("fills the highlighted command on a space after filter text", async () => {
    expect(await typeIntoPalette("review ")).toMatchObject({ value: "/review-pr", fill: true });
  });

  it("runs the highlighted command on Enter and draws a done line", async () => {
    const result = await typeIntoPalette(`re${ENTER}`);
    expect(result).toMatchObject({ value: "/rename", fill: false });
    expect(result.drawn).toContain(DONE_MARK);
  });

  it("fills nothing on Tab when no command matches", async () => {
    expect(await typeIntoPalette(`xyz${TAB}${ENTER}`)).toMatchObject({
      value: undefined,
      fill: false,
    });
  });
});

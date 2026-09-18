import { main, autoApproved, nullPayload } from "./agent.js";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-code-diffs-"));
const policyFile = join(dir, "policy.json");

// "a" approves each of the two interrupts at the menu.
const answers = ["a", "a"];
let asked = 0;
globalThis.__agencyInputOverride = async () => {
  asked += 1;
  const a = answers.shift();
  if (a === undefined) throw new Error("Unexpected extra input() call");
  return a;
};

// Everything the handler printed, so we can check what reached the
// terminal alongside each prompt.
let survivedNullPayload = "threw";
let printed = "";
const realLog = console.log;
console.log = (...args) => {
  printed += args.join(" ") + "\n";
};

try {
  await main({ policyFile });
  await autoApproved({ policyFile });
  survivedNullPayload = (await nullPayload({ policyFile })).data;
} finally {
  console.log = realLog;
  rmSync(dir, { recursive: true, force: true });
}

// The diff body, with the ANSI the highlighter adds taken back off.
const plain = printed.replace(/\x1b\[[\d;]*m/g, "");
// The table row the tool's name renders on, which is where a CR the
// strip missed would do its damage.
const nameRow = (printed.split("\n").find((line) => line.includes("greetHindi")) ?? "");

writeFileSync("__result.json", JSON.stringify({
  editHeader: plain.includes("⏺ Edit: greet.agency"),
  editShowsChange: plain.includes("\"hi\"") && plain.includes("\"hello\""),
  toolHeader: plain.includes("⏺ Tool: greetHindi"),
  // The redraft diffs against the previous draft, so both sides show.
  toolShowsChange: plain.includes("namaste") && plain.includes("hello"),
  // The source belongs in the diff and nowhere else. If the prompt's
  // key/value table still carried it, the new line would appear twice.
  sourceShownOnce: (plain.match(/namaste/g) || []).length === 1,
  // A rule approved this one without asking, and the diff still printed.
  autoApprovedHeader: plain.includes("⏺ Tool: silentTool"),
  autoApprovedShowsSource: plain.includes("quiet"),
  // Two prompts for the two interrupts main raises. The rule-approved
  // one draws none, so a third answer would mean it prompted after all.
  promptsDrawn: asked,
  // The draft's escape sequence never reaches the terminal. `plain` has
  // had the highlighter's own colors removed, so what is left is the
  // raw ESC the model wrote.
  controlCharsStripped: !printed.includes("\u001b[2J"),
  // The table keeps a CR, which would put " wiped" on top of the name.
  // Scoped to the row the name renders on: a CR anywhere else in the
  // output is not this assertion's business.
  carriageReturnStripped: !nameRow.includes("\r"),
  // The trojan-source characters that make code read as something else,
  // in the draft and in the interrupt's own message.
  bidiOverrideStripped: !printed.includes("\u202e") && !printed.includes("\u061c"),
  survivedNullPayload,
  titleReached: plain.includes("review this tool?"),
}, null, 2));

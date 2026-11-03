import { main, autoApproved, autoApprovedWrite, nullPayload } from "./agent.js";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "policy-code-diffs-"));
const policyFile = join(dir, "policy.json");

// "a" approves each of the nine interrupts at the menu.
const answers = ["a", "a", "a", "a", "a", "a", "a", "a", "a"];
let asked = 0;
const inputOverride = async () => {
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
  await main({ policyFile }, { inputOverride });
  await autoApproved({ policyFile }, { inputOverride });
  await autoApprovedWrite({ policyFile }, { inputOverride });
  survivedNullPayload = (await nullPayload({ policyFile }, { inputOverride })).data;
} finally {
  console.log = realLog;
  rmSync(dir, { recursive: true, force: true });
}

// The diff body, with the ANSI the highlighter adds taken back off.
const plain = printed.replace(/\x1b\[[\d;]*m/g, "");
// Every line of the prompt's key/value tables.
const tableLines = plain.split("\n").filter((line) => line.includes("│"));
// The table row the tool's name renders on, which is where a CR the
// strip missed would do its damage.
const nameRow = (printed.split("\n").find((line) => line.includes("greetHindi")) ?? "");
const writePreview = printed.slice(
  printed.indexOf("⏺ Write (overwrite): write.js"),
  printed.indexOf("⏺ Write (create-only): empty.js"),
);

writeFileSync("__result.json", JSON.stringify({
  writeHeader: plain.includes("⏺ Write (overwrite): write.js"),
  writeContentShownOnce: (plain.match(/write-preview-tail/g) || []).length === 1,
  writeSyntaxHighlighted: /\x1b\[38;2;[\d;]+m/.test(writePreview),
  writeContentOutsideTable: !tableLines.some((line) => line.includes("write-preview-tail")),
  writeMetadataKept: tableLines.some((line) => line.includes("write.js")) &&
    tableLines.some((line) => line.includes("overwrite")),
  emptyWritePreview: plain.includes("⏺ Write (create-only): empty.js"),
  metadataWriteKept: tableLines.some((line) => line.includes("metadata.agency")),
  metadataWriteHasNoPreview: !plain.includes("⏺ Write: metadata.agency"),
  nonTextWriteContentKept: tableLines.some((line) => line.includes("structured-write-content")),
  autoApprovedWriteShownOnce: plain.includes("⏺ Write (append): append.js") &&
    (plain.match(/auto-write-preview/g) || []).length === 1,
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
  // Only main prompts; the rule-approved interrupts draw no prompt.
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
  // The reviewer's advice, its open objections, and the point the
  // author could not fix with its reason, each printed once: under the
  // diff, and not again in the prompt's table.
  reviewerNoteShown: (plain.match(/search results carry no dates/g) || []).length === 1,
  blockingShown: (plain.match(/run ignores the topic/g) || []).length === 1,
  unresolvedShown:
    plain.includes("Reviewer: asks for a publication time") &&
    plain.includes("Author: no std search returns one"),
  // Only the resumed draft says it is one.
  resumedDraftSaysSo: (plain.match(/draft from earlier in this session/g) || []).length === 1,
  // A draft with nothing said about it prints no findings headings.
  quietDraftHasNoFindings: (plain.match(/The reviewer notes:/g) || []).length === 1,
  survivedNullPayload,
  titleReached: plain.includes("review this tool?"),
  // The prompt's tables are drawn at the prompt's width. stdout is a
  // pipe here, so that width is 78 on every machine.
  tablesFitPrompt: tableLines.length > 0 && tableLines.every((line) => line.length <= 78),
  longDirKept: tableLines.join("").replace(/[│\s]/g, "").includes("a".repeat(200)),
  // A skill draft prints above the prompt, like a diff: its name, its
  // description, and its body, the body once and not again in the table.
  skillHeader: plain.includes("⏺ Skill: tv-tables"),
  skillShowsDescription: plain.includes("Show tables in tv when the user asks"),
  skillBodyShownOnce: (plain.match(/Run tv agent new yourself/g) || []).length === 1,
  // The body is shown as written. Rendered as markdown, a link would show
  // only its text and hide the URL the user is approving.
  skillBodyAsWritten: plain.includes("[the docs](https://example.com/x)"),
  // A workflow draft prints above the prompt with its round. The first
  // round shows the JSON once, the second a diff against the first, so the
  // first draft's text appears twice in all and the second's once. The
  // warning prints once, under the first round, and not in the table.
  workflowHeader: plain.includes("⏺ Workflow: avgOfThree (round 1 of 3)") &&
    plain.includes("⏺ Workflow: avgOfThree (round 2 of 3)"),
  workflowFirstRoundShown: (plain.match(/first-round-marker/g) || []).length === 2,
  workflowSecondRoundShown: (plain.match(/second-round-marker/g) || []).length === 1,
  workflowWarningShownOnce:
    (plain.match(/step sum, result: untyped-warning-marker/g) || []).length === 1,
}, null, 2));

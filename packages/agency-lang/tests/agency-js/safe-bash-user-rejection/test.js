import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "safe-bash-user-rejection-"));
const policyFile = join(dir, "policy.json");

// "r" rejects at the menu; the second answer is the message the user writes.
const answers = ["r", "why are you running this?"];
const inputOverride = async () => {
  const answer = answers.shift();
  if (answer === undefined) throw new Error("Unexpected extra input() call");
  return answer;
};

const requests = [];
const callbacks = {
  onLLMCallStart: ({ messages }) => {
    requests.push(messages);
  },
};

try {
  const result = await main({ policyFile }, { inputOverride, callbacks });
  const final = requests[requests.length - 1];
  writeFileSync(
    "__result.json",
    JSON.stringify(
      {
        result: result.data,
        remainingAnswers: answers.length,
        toolReply: final
          .filter((message) => message.role === "tool")
          .map((message) => message.content),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

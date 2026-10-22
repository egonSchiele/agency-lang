import { writeFileSync } from "fs";
import { main, rewindFrom, patchCheckpoint } from "./agent.js";

const fresh = await main();
const checkpoint = fresh.data.cp;

// Rewind with an edit list: the local changes, and the appended message
// is in the thread the second call sends.
const edited = await rewindFrom(checkpoint, {}, {
  edits: [
    { op: "setLocal", name: "mood", value: "happy" },
    { op: "appendMessage", text: "Stop." },
  ],
});
// The thread the run returns, whatever shape it comes in, as text.
const sent = JSON.stringify(edited.messages);

// The old override shape still works, as an edit on the same frame.
const overridden = await rewindFrom(checkpoint, { mood: "calm" });

// patchCheckpoint alone: a refusal names the reason and gives no checkpoint.
const refused = patchCheckpoint(checkpoint, [{ op: "removeTool", tool: "x" }]);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      fresh: fresh.data.value,
      edited: edited.data.value,
      stopWasSent: sent.includes('"Stop."'),
      overridden: overridden.data.value,
      refused: "refused" in refused ? refused.refused : "accepted",
    },
    null,
    2,
  ),
);

import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
const frames = result.data;

const firstPromptFrame = frames.findIndex((frame) =>
  frame.includes("{bright-blue You} ping"),
);
const replyFrame = frames.findIndex((frame) =>
  frame.includes("{green Agent} finished ping"),
);

const sawPromptBeforeReply =
  firstPromptFrame >= 0 && replyFrame >= 0 && firstPromptFrame <= replyFrame;
const sawBusy =
  frames.some((frame) => frame.includes("Thinking") && frame.includes("0s"));

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      sawPromptBeforeReply,
      sawBusy,
      sawReply: replyFrame >= 0,
    },
    null,
    2,
  ),
);

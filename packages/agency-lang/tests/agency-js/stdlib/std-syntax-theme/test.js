import { writeFileSync } from "fs";
import { named, themedDiff } from "./agent.js";

const namedOut = (await named()).data;
const diffOut = (await themedDiff()).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      // monokai keyword #f92672 = 249,38,114
      named: { monokaiKeyword: namedOut.includes("38;2;249;38;114") },
      // themed diff: monokai fg AND the green/red diff backgrounds
      diff: {
        monokaiKeyword: diffOut.includes("38;2;249;38;114"),
        hasRedBg: diffOut.includes("\x1b[48;2;60;0;0m"),
        hasGreenBg: diffOut.includes("\x1b[48;2;0;45;0m"),
      },
    },
    null,
    2,
  ),
);

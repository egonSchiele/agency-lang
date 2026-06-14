import { writeFileSync } from "fs";
import { highlightedDiff, plainDiff } from "./agent.js";

const RED_BG = "\x1b[48;2;60;0;0m";
const GREEN_BG = "\x1b[48;2;0;45;0m";

const hl = (await highlightedDiff("const x = 1", "const x = 2")).data;
const plain = (await plainDiff("const x = 1", "const x = 2")).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      highlighted: {
        hasRedBg: hl.includes(RED_BG),
        hasGreenBg: hl.includes(GREEN_BG),
        hasForeground: /\x1b\[38;2;/.test(hl),
      },
      // plain mode (no language) must NOT use a background tint
      plain: {
        hasBg: plain.includes(RED_BG) || plain.includes(GREEN_BG),
      },
    },
    null,
    2,
  ),
);

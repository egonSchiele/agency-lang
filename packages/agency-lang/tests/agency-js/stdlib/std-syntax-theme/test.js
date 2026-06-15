import { writeFileSync } from "fs";
import { named, custom, themedDiff, badTheme } from "./agent.js";

const namedOut = (await named()).data;
const customOut = (await custom()).data;
const diffOut = (await themedDiff()).data;
// A bad theme throws inside highlight; Agency's auto try-catch turns it into a
// failure, so the node's return value is a failure Result.
const badOut = (await badTheme()).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      // monokai keyword #f92672 = 249,38,114
      named: { monokaiKeyword: namedOut.includes("38;2;249;38;114") },
      // custom red keyword
      custom: { redKeyword: customOut.includes("38;2;255;0;0") },
      // themed diff: monokai fg AND the green/red diff backgrounds
      diff: {
        monokaiKeyword: diffOut.includes("38;2;249;38;114"),
        hasRedBg: diffOut.includes("\x1b[48;2;60;0;0m"),
        hasGreenBg: diffOut.includes("\x1b[48;2;0;45;0m"),
      },
      // unknown scheme -> failure
      bad: { isFailure: badOut && badOut.success === false },
    },
    null,
    2,
  ),
);

import { classify, classifyNullable } from "./agent.js";
import { writeFileSync } from "fs";

const matched = (await classify("a")).data;
const unmatched = (await classify("z")).data;

const realArm = (await classifyNullable("a")).data;
const nullArm = (await classifyNullable("n")).data;
const noArm = (await classifyNullable("z")).data;

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      matchedValue: matched,
      unmatchedIsNull: unmatched === null,
      realArmValue: realArm,
      nullArmIsNull: nullArm === null,
      noArmIsNull: noArm === null,
    },
    null,
    2,
  ),
);

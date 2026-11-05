import { main, rewindFrom } from "./agent.js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

try {
  unlinkSync("statelog.log");
} catch {
  // ignore ENOENT
}

const fresh = await main();
const rewound = await rewindFrom(fresh.data.cp, { mood: "rewound" });

const lines = readFileSync("statelog.log", "utf-8").trim().split("\n");
const typesHolding = (text) =>
  lines.filter((line) => line.includes(text)).map((line) => JSON.parse(line).data.type);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      rewoundValue: rewound.data.value,
      rewoundValueLoggedIn: typesHolding("mood-is-rewound"),
      freshValueLoggedIn: typesHolding("mood-is-sad"),
    },
    null,
    2,
  ),
);

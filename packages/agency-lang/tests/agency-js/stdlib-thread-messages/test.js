import { main } from "./agent.js";
import { writeFileSync } from "fs";
import { messagesFixture } from "../messagesFixture.mjs";

const result = await main();
writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data, messages: messagesFixture(result.messages) }, null, 2),
);

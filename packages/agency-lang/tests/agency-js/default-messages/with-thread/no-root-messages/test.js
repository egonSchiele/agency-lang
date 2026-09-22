import { primes } from "./agent.js";
import { writeFileSync } from "fs";
import { messagesFixture } from "../../../messagesFixture.mjs";

const result = await primes();
console.log(result);
writeFileSync(
  "__result.json",
  JSON.stringify({ messages: messagesFixture(result.messages) }, null, 2),
);

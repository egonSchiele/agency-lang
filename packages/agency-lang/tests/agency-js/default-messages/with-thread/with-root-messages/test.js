import { primes } from "./agent.js";
import { writeFileSync } from "fs";

const result = await primes();
console.log(result);
writeFileSync(
  "__result.json",
  JSON.stringify({ messages: result.messages }, null, 2),
);

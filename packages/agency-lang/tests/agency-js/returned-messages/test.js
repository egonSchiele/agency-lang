import { primes } from "./agent.js";
import { writeFileSync } from "fs";

const result = await primes();
console.log(result);
writeFileSync("__result.json", JSON.stringify({ data: result.data }, null, 2));

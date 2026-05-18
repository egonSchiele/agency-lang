import { main } from "./basic.js";

const result = await main();
const value = result?.data ?? result;

if (value !== "basic-ok") {
  console.error("Unexpected compiled result", result);
  process.exit(1);
}

console.log("compiled-ok");

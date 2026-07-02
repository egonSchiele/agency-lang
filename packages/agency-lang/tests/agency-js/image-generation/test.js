import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
// Include `messages` so the fixture asserts the generated image reached the
// thread as an attachment part. The 1x1 PNG base64 is fixed/deterministic.
writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data, messages: result.messages }, null, 2),
);

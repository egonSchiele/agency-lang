import { main } from "./agent.js";
import { writeFileSync } from "fs";

const entries = [];
const result = await main(5, {
  callbacks: {
    onAudit: (entry) => {
      // Strip timestamps for deterministic comparison
      const { timestamp, ...rest } = entry;
      entries.push(rest);
    }
  }
});

writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data, auditTypes: entries.map(e => e.type) }, null, 2),
);

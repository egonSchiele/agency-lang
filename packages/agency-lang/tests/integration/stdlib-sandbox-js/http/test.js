import http from "node:http";
import { main } from "./agent.js";
import { writeFileSync } from "node:fs";

// Start a local test server
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("hello from test server");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
process.env.TEST_HTTP_PORT = String(port);

try {
  const result = await main();
  const body = result?.data ?? result;
  writeFileSync("__result.json", JSON.stringify({ body }, null, 2));
} finally {
  server.close();
}

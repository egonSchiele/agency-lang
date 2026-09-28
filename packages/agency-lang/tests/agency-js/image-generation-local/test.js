import * as http from "node:http";
import { writeFileSync } from "fs";

// A stand-in for `agency local serve --image`: one 1x1 PNG, with the seed
// the request asked for. It records the request so the fixture checks what
// generateImageLocal sent.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const requests = [];
const server = http.createServer((req, res) => {
  let text = "";
  req.on("data", (chunk) => (text += chunk));
  req.on("end", () => {
    const body = JSON.parse(text);
    requests.push({ path: req.url, ...body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output_format: "png", data: [{ b64_json: PNG, seed: body.seed }] }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.MLX_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
// CI runs the suite with the deterministic LLM client, whose image() answers
// with a fixed PNG and never reaches a provider. This test is about the real
// path from generateImageLocal through the mlx provider to the server, so
// the mocks are switched off before the program is imported and installs
// its client.
delete process.env.AGENCY_LLM_MOCKS;

const { main } = await import("./agent.js");
const result = await main();
server.close();
writeFileSync("__result.json", JSON.stringify({ data: result.data, requests }, null, 2));

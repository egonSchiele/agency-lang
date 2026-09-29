import * as http from "node:http";

// A stand-in for `agency local serve --image`: one 1x1 PNG, with the seed
// the request asked for. It records every request, so the result shows
// what generateImageLocal sent, and that a rejected read sent nothing.
//
// test.js imports this module before the program. Imports are evaluated in
// order, and this one finishes its `await` first, so the environment is
// set before the program loads and installs its client.
export const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
export const requests = [];
export const server = http.createServer((req, res) => {
  let text = "";
  req.on("data", (chunk) => (text += chunk));
  req.on("end", () => {
    const body = JSON.parse(text);
    requests.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output_format: "png", data: [{ b64_json: PNG, seed: body.seed }] }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.MLX_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
// The deterministic LLM client answers image() itself. This test is about
// the real path through the mlx provider to the server, so the mocks are
// switched off.
delete process.env.AGENCY_LLM_MOCKS;

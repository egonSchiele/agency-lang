import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A stand-in for `agency local serve --image`: one 1x1 PNG, with the seed
// the request asked for. It records every request, so the result shows
// what generateImageLocal sent, and that a rejected read sent nothing.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const requests = [];
const server = http.createServer((req, res) => {
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
// switched off before the program is imported and installs its client.
delete process.env.AGENCY_LLM_MOCKS;

// The drawing, in a folder spelled without links so the interrupt's
// payload can be compared with it.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "controlnet-")));
const drawing = path.join(dir, "pose.png");
fs.writeFileSync(drawing, Buffer.from(PNG, "base64"));

const {
  withControl,
  withoutControl,
  imageWithoutControlnet,
  hasInterrupts,
  approve,
  reject,
  respondToInterrupts,
} = await import("./agent.js");

/** What one interrupt asked, with the folder checked against the real one. */
function asked(result) {
  if (!hasInterrupts(result.data)) {
    return { interrupted: false };
  }
  const [intr] = result.data;
  return {
    interrupted: true,
    count: result.data.length,
    effect: intr.effect,
    dirIsReal: intr.data.dir === dir,
    filename: intr.data.filename,
  };
}

/** A request with the control image replaced by whether it is the file's bytes. */
function sent(body) {
  if (body.control_image === undefined) {
    return body;
  }
  const { control_image, ...rest } = body;
  return { ...rest, controlImageIsTheFile: control_image === PNG };
}

const out = {};

// Rejecting the read sends nothing to the server.
const first = await withControl(drawing);
out.rejectAsked = asked(first);
const rejected = await respondToInterrupts(first.data, [reject()]);
out.rejected = rejected.data;
out.requestsAfterReject = requests.length;

// Approving it sends the drawing's bytes with the ControlNet settings.
const second = await withControl(drawing);
out.approveAsked = asked(second);
const approved = await respondToInterrupts(second.data, [approve()]);
out.approved = approved.data;

// A call with no control image raises nothing.
const plain = await withoutControl();
out.plainAsked = asked(plain);
out.plain = plain.data;

// A control image with no ControlNet is refused before any approval is asked for.
const half = await imageWithoutControlnet(drawing);
out.halfAsked = asked(half);
out.half = half.data;

out.requests = requests.map(sent);
server.close();
fs.rmSync(dir, { recursive: true, force: true });
fs.writeFileSync("__result.json", JSON.stringify(out, null, 2));

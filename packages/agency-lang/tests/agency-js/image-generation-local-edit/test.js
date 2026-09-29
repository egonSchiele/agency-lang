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

// Two pictures with different bytes, in a folder spelled without links so
// each interrupt's payload can be compared with it.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edit-")));
const cat = path.join(dir, "cat.png");
const hat = path.join(dir, "hat.png");
const catBytes = Buffer.from(PNG, "base64");
const hatBytes = Buffer.concat([catBytes, Buffer.from("hat")]);
fs.writeFileSync(cat, catBytes);
fs.writeFileSync(hat, hatBytes);

const { edit, plain, hasInterrupts, approve, reject, respondToInterrupts } =
  await import("./agent.js");

/** What one round of interrupts asked, with the folder checked against the real one. */
function asked(result) {
  if (!hasInterrupts(result.data)) {
    return { interrupted: false };
  }
  return {
    interrupted: true,
    asks: result.data.map((intr) => ({
      effect: intr.effect,
      dirIsReal: intr.data.dir === dir,
      filename: intr.data.filename,
    })),
  };
}

/** A request with each reference replaced by the name of the file whose
 *  bytes it decodes to. */
function sent(body) {
  if (body.images === undefined) {
    return body;
  }
  const { images, ...rest } = body;
  const named = images.map((image) => {
    const bytes = Buffer.from(image, "base64");
    if (bytes.equals(catBytes)) {
      return "cat.png";
    }
    return bytes.equals(hatBytes) ? "hat.png" : "other bytes";
  });
  return { ...rest, images: named };
}

const out = {};

// Two references raise two reads, one after the other. After both are
// approved the server gets both files' bytes, in order.
const first = await edit([cat, hat]);
out.firstAsked = asked(first);
const second = await respondToInterrupts(first.data, [approve()]);
out.secondAsked = asked(second);
const approved = await respondToInterrupts(second.data, [approve()]);
out.approved = approved.data;
out.requestsAfterApprove = requests.length;

// Rejecting the second read sends nothing.
const again = await edit([cat, hat]);
const againSecond = await respondToInterrupts(again.data, [approve()]);
const rejected = await respondToInterrupts(againSecond.data, [reject()]);
out.rejected = rejected.data;
out.requestsAfterReject = requests.length;

// A missing file fails before anything is asked.
const missing = await edit([cat, path.join(dir, "nope.png")]);
out.missingAsked = asked(missing);
out.missing = { ok: missing.data.ok, error: missing.data.error.replace(dir, "DIR") };

// Five paths fail before anything is asked.
const five = await edit([cat, cat, cat, cat, cat]);
out.fiveAsked = asked(five);
out.five = five.data;

// A call with no references raises nothing and sends no images field.
const none = await plain();
out.plainAsked = asked(none);
out.plain = none.data;

out.requests = requests.map(sent);
server.close();
fs.rmSync(dir, { recursive: true, force: true });
fs.writeFileSync("__result.json", JSON.stringify(out, null, 2));

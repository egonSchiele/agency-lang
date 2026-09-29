import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  edit,
  hasInterrupts,
  approve,
  reject,
  respondToInterrupts,
  __setLLMClient,
} from "./agent.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const URL = "https://example.com/cat.png";

// A client that records what each image request carried, and answers with
// the same 1x1 PNG. A rejected upload must leave nothing here.
const requests = [];
__setLLMClient({
  async text() {
    return { success: false, error: "text is not used here" };
  },
  async *textStream() {},
  async embed() {
    return { success: false, error: "embed is not used here" };
  },
  async image(input, config) {
    requests.push({ model: config.model, images: input.images.map(describeRef) });
    return {
      success: true,
      value: {
        images: [{ data: new Uint8Array(Buffer.from(PNG, "base64")), mimeType: "image/png" }],
        model: config.model,
      },
    };
  },
});

/** An image reference, with any bytes replaced by which file they are. */
function describeRef(ref) {
  if (ref.kind !== "bytes") {
    return ref;
  }
  const base64 = Buffer.from(ref.data).toString("base64");
  return { kind: ref.kind, mimeType: ref.mimeType, bytes: whichFile[base64] ?? "other" };
}

// Two images, in a folder spelled without links so the interrupt's payload
// can be compared with it. Their bytes differ so the request shows which
// file was sent.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "upload-")));
const cat = path.join(dir, "cat.png");
const dog = path.join(dir, "dog.png");
fs.writeFileSync(cat, Buffer.from(PNG, "base64"));
fs.writeFileSync(dog, Buffer.concat([Buffer.from(PNG, "base64"), Buffer.from("dog")]));
const whichFile = {
  [fs.readFileSync(cat).toString("base64")]: "cat.png",
  [fs.readFileSync(dog).toString("base64")]: "dog.png",
};

/** What the pending interrupts asked, with the folder checked against the real one. */
function asked(result) {
  if (!hasInterrupts(result.data)) {
    return { interrupted: false };
  }
  return result.data.map((intr) => ({
    effect: intr.effect,
    dirIsReal: intr.data.dir === dir,
    filename: intr.data.filename,
    provider: intr.data.provider,
    model: intr.data.model,
    baseUrl: intr.data.baseUrl,
  }));
}

const out = {};

// Rejecting the upload sends nothing.
const first = await edit([cat]);
out.rejectAsked = asked(first);
out.rejected = (await respondToInterrupts(first.data, [reject()])).data;
out.requestsAfterReject = requests.length;

// Approving it sends the file's bytes, not its path.
const second = await edit([cat]);
out.approveAsked = asked(second);
out.approved = (await respondToInterrupts(second.data, [approve()])).data;

// Two local files are asked about one at a time, and both are sent once
// both are approved. A URL between them asks nothing.
const third = await edit([cat, URL, dog]);
out.firstOfTwo = asked(third);
const afterFirst = await respondToInterrupts(third.data, [approve()]);
out.secondOfTwo = asked(afterFirst);
out.both = (await respondToInterrupts(afterFirst.data, [approve()])).data;

// A URL alone reads no local file and asks nothing.
const remote = await edit([URL]);
out.urlAsked = asked(remote);
out.url = remote.data;

// A missing file fails before anything is asked.
const missing = await edit([path.join(dir, "missing.png")]);
out.missingAsked = asked(missing);
out.missingFailed = missing.data.ok === false && missing.data.error.includes("no such file");

out.requests = requests;
fs.rmSync(dir, { recursive: true, force: true });
fs.writeFileSync("__result.json", JSON.stringify(out, null, 2));

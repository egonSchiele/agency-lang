import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG, requests, server } from "./server.js";
import {
  edit,
  plain,
  redraw,
  inpaint,
  hasInterrupts,
  approve,
  reject,
  respondToInterrupts,
} from "./agent.js";

// Two pictures with different bytes, in a folder spelled without links so
// each interrupt's payload can be compared with it.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edit-")));
const cat = path.join(dir, "cat.png");
const hat = path.join(dir, "hat.png");
const catBytes = Buffer.from(PNG, "base64");
const hatBytes = Buffer.concat([catBytes, Buffer.from("hat")]);
fs.writeFileSync(cat, catBytes);
fs.writeFileSync(hat, hatBytes);

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

/** The name of the file whose bytes a base64 image decodes to. */
function named(image) {
  const bytes = Buffer.from(image, "base64");
  if (bytes.equals(catBytes)) {
    return "cat.png";
  }
  return bytes.equals(hatBytes) ? "hat.png" : "other bytes";
}

/** A request with each input image replaced by the name of its file. */
function sent(body) {
  const out = { ...body };
  if (body.images !== undefined) {
    out.images = body.images.map(named);
  }
  if (body.start_image !== undefined) {
    out.start_image = named(body.start_image);
  }
  if (body.mask_image !== undefined) {
    out.mask_image = named(body.mask_image);
  }
  return out;
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

// A start image raises one read. After approval the server gets its bytes
// as one string, with the strength.
const start = await redraw(cat);
out.startAsked = asked(start);
const redrawn = await respondToInterrupts(start.data, [approve()]);
out.redrawn = redrawn.data;
out.requestsAfterRedraw = requests.length;

// Rejecting the read sends nothing.
const startAgain = await redraw(cat);
const startRejected = await respondToInterrupts(startAgain.data, [reject()]);
out.startRejected = startRejected.data;
out.requestsAfterStartReject = requests.length;

// A missing start image fails before anything is asked.
const startMissing = await redraw(path.join(dir, "nope.png"));
out.startMissingAsked = asked(startMissing);
out.startMissing = {
  ok: startMissing.data.ok,
  error: startMissing.data.error.replace(dir, "DIR"),
};

// A start image with a mask raises two reads, the picture and then the
// mask. After both are approved the server gets both files' bytes, each as
// one string, with the strength.
const inpainting = await inpaint(cat, hat);
out.inpaintFirstAsked = asked(inpainting);
const inpaintSecond = await respondToInterrupts(inpainting.data, [approve()]);
out.inpaintSecondAsked = asked(inpaintSecond);
const inpainted = await respondToInterrupts(inpaintSecond.data, [approve()]);
out.inpainted = inpainted.data;
out.requestsAfterInpaint = requests.length;

// Rejecting the mask's read sends nothing.
const inpaintAgain = await inpaint(cat, hat);
const inpaintAgainSecond = await respondToInterrupts(inpaintAgain.data, [approve()]);
const maskRejected = await respondToInterrupts(inpaintAgainSecond.data, [reject()]);
out.maskRejected = maskRejected.data;
out.requestsAfterMaskReject = requests.length;

// A mask with no start image fails before anything is asked.
const maskAlone = await inpaint("", hat);
out.maskAloneAsked = asked(maskAlone);
out.maskAlone = maskAlone.data;

out.requests = requests.map(sent);
server.close();
fs.rmSync(dir, { recursive: true, force: true });
fs.writeFileSync("__result.json", JSON.stringify(out, null, 2));

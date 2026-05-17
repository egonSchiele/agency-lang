import { describe, it, expect } from "vitest";
import { FrameRecorder } from "../output/recorder.js";
import { Frame } from "../frame.js";
import { layout } from "../layout.js";
import { render } from "../render/renderer.js";
import { line } from "../builders.js";

describe("FrameRecorder", () => {
  it("records frames with labels", () => {
    const recorder = new FrameRecorder();
    const frame = new Frame({ x: 0, y: 0, width: 80, height: 24, style: {} });
    recorder.write(frame, "press s");
    expect(recorder.frames).toHaveLength(1);
    expect(recorder.frames[0].label).toBe("press s");
  });

  it("writeHTML produces valid HTML with all frames", () => {
    const recorder = new FrameRecorder();
    recorder.write(
      new Frame({ x: 0, y: 0, width: 10, height: 2, style: {},
        content: [[{ char: "h" }, { char: "i" }]] }),
      "step 1"
    );
    recorder.write(
      new Frame({ x: 0, y: 0, width: 10, height: 2, style: {},
        content: [[{ char: "b" }, { char: "y" }]] }),
      "step 2"
    );
    const html = recorder.toHTML();
    expect(html).toContain("step 1");
    expect(html).toContain("step 2");
    expect(html).toContain("<pre");
  });

  it("textAt() and lastText() expose recorded frames as plain text", () => {
    const recorder = new FrameRecorder();
    recorder.write(render(layout(line("first"), 10, 1)));
    recorder.write(render(layout(line("second"), 10, 1)));
    expect(recorder.textAt(0).trim()).toBe("first");
    expect(recorder.lastText().trim()).toBe("second");
  });
});

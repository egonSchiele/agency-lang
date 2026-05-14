import * as fs from "node:fs";
import { Frame } from "../frame.js";
import type { Cell } from "../elements.js";
import type { OutputTarget } from "./types.js";
import { toHTML as frameToHTML } from "../render/html.js";
import { escapeHtml } from "../utils.js";

type RecordedFrame = {
  frame: Frame;
  label?: string;
};

function cloneContent(content: Cell[][] | undefined): Cell[][] | undefined {
  return content?.map((row) => row.map((cell) => ({ ...cell })));
}

function cloneFrame(frame: Frame): Frame {
  return new Frame({
    key: frame.key,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    style: { ...frame.style },
    content: cloneContent(frame.content),
    children: frame.children?.map(cloneFrame),
  });
}

export class FrameRecorder implements OutputTarget {
  frames: RecordedFrame[] = [];

  write(frame: Frame, label?: string): void {
    // Deep-clone so that downstream mutation of frames never alters
    // already-recorded snapshots.
    this.frames.push({ frame: cloneFrame(frame), label });
  }

  clear(): void {
    this.frames = [];
  }

  toHTML(): string {
    const frameHtmls = this.frames.map((entry, i) => {
      const label = entry.label ?? `Frame ${i + 1}`;
      const rendered = frameToHTML(entry.frame);
      return `<div class="frame" id="frame-${i}">
<h3>${escapeHtml(label)}</h3>
${rendered}
</div>`;
    });

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>TUI Frames</title>
<style>
body { background: #1e1e1e; color: #ccc; font-family: sans-serif; padding: 20px; }
.frame { margin-bottom: 20px; }
.frame h3 { color: #7af; margin: 0 0 8px 0; font-size: 14px; }
pre { background: #000; padding: 4px; border: 1px solid #333; display: inline-block; }
.nav { position: fixed; top: 10px; right: 20px; background: #333; padding: 10px; border-radius: 4px; }
.nav button { margin: 0 4px; padding: 4px 12px; cursor: pointer; }
</style>
</head>
<body>
<div class="nav">
<button onclick="prev()">Prev</button>
<span id="counter">1 / ${this.frames.length}</span>
<button onclick="next()">Next</button>
</div>
${frameHtmls.join("\n")}
<script>
const frames = document.querySelectorAll('.frame');
let current = 0;
function show(i) {
  frames.forEach((f, j) => f.style.display = j === i ? 'block' : 'none');
  document.getElementById('counter').textContent = (i+1) + ' / ' + frames.length;
  current = i;
}
function prev() { if (current > 0) show(current - 1); }
function next() { if (current < frames.length - 1) show(current + 1); }
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') prev();
  if (e.key === 'ArrowRight') next();
});
show(0);
</script>
</body>
</html>`;
  }

  writeHTML(path: string): void {
    fs.writeFileSync(path, this.toHTML());
  }
}

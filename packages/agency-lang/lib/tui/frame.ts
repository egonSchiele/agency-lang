import type { Cell, FrameStyle } from "./elements.js";
import { toPlainText as toPlainTextAdapter } from "./render/plaintext.js";
import { toHTML as toHTMLAdapter } from "./render/html.js";
import * as fs from "node:fs";

type FrameArgs = {
  key?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: FrameStyle;
  content?: Cell[][];
  children?: Frame[];
};

export class Frame {
  key?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: FrameStyle;
  content?: Cell[][];
  children?: Frame[];

  // Lazily computed flat 2D cell grid; reset whenever the frame is mutated.
  // Frames are not currently mutated post-construction, but this cache
  // makes toPlainText/toHTML/toANSI on the same frame O(1) for repeat calls.
  private _flatCache?: Cell[][];

  constructor(args: FrameArgs) {
    this.key = args.key;
    this.x = args.x;
    this.y = args.y;
    this.width = args.width;
    this.height = args.height;
    this.style = args.style;
    this.content = args.content;
    this.children = args.children;
  }

  /** Internal: get cached flattened grid, computing it on first access. */
  getFlattened(compute: () => Cell[][]): Cell[][] {
    if (!this._flatCache) this._flatCache = compute();
    return this._flatCache;
  }

  findByKey(key: string): Frame | undefined {
    if (this.key === key) return this;
    if (!this.children) return undefined;
    for (const child of this.children) {
      const found = child.findByKey(key);
      if (found) return found;
    }
    return undefined;
  }

  toPlainText(): string {
    return toPlainTextAdapter(this);
  }

  toHTML(): string {
    return toHTMLAdapter(this);
  }

  /**
   * Writes the frame's HTML rendering to a file.
   *
   * NOTE: `path` is written verbatim. This method is intended for
   * developer/test use; do not pass user-controlled paths.
   */
  image(path: string): void {
    fs.writeFileSync(path, this.toHTML());
  }
}

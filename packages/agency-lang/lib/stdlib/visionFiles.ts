import type { HubFile } from "./hubClient.js";

/** The files a vision repo ships that the vision server never reads: the
 *  same weights in other formats, and code. `.bin` and `.msgpack` load
 *  through pickle or flax; `.py` is remote code, which is never run. */
const DROPPED = /\.(bin|msgpack|h5|pt|pth|ckpt|py|ipynb)$/i;

/** A vision snapshot cut down to what the server reads: the config, the
 *  tokenizer and processor files, the `.safetensors` or `.onnx` weights,
 *  and the tag list. Everything is kept unless its extension says it is
 *  another copy of the weights or code. */
export function visionFiles(files: HubFile[]): HubFile[] {
  return files.filter((file) => !DROPPED.test(file.path));
}

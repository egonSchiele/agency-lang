import type { HubFile } from "./hubClient.js";
import { VISION_ONNX_FILES } from "./modelKind.js";

/** The files a vision repo ships that the vision server never reads: the
 *  same weights in other formats, and code. `.bin` and `.msgpack` load
 *  through pickle or flax; `.py` is remote code, which is never run. */
const DROPPED = /\.(bin|msgpack|h5|pt|pth|ckpt|py|ipynb)$/i;

/** An ONNX model's `.safetensors` copy of the same weights. The WD14 tagger
 *  runs on onnxruntime, which reads only `model.onnx`. */
const SAFETENSORS = /\.safetensors$/i;

/** A vision snapshot cut down to what the server reads: the config, the
 *  tokenizer and processor files, one copy of the weights, and the tag
 *  list. A WD14 snapshot, marked by `model.onnx` beside
 *  `selected_tags.csv`, keeps the `.onnx` weights and drops the
 *  `.safetensors`. Any other keeps its `.safetensors`. Everything else is
 *  kept unless its extension says it is another copy of the weights or
 *  code. */
export function visionFiles(files: HubFile[]): HubFile[] {
  const names = files.map((file) => file.path);
  const isOnnxModel = VISION_ONNX_FILES.every((name) => names.includes(name));
  return files.filter(
    (file) => !DROPPED.test(file.path) && !(isOnnxModel && SAFETENSORS.test(file.path)),
  );
}

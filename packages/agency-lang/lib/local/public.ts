// The public surface a TypeScript program imports to use local models
// with no `.agency` file:
//   import { listModels, serve, generateImage, tagImage } from "agency-lang/local";
export { listModels } from "./models.js";
export type { LocalModel, LocalModelAlias } from "./models.js";
export {
  generateImage,
  detectObjects,
  tagImage,
  captionImage,
  embedImage,
  findRegions,
} from "./calls.js";
export type {
  CallOptions,
  ImageInput,
  GenerateImageOptions,
  GeneratedImage,
  VisionOptions,
  BoundingBox,
  Detection,
  Region,
  Tag,
} from "./calls.js";
export { serve } from "./serve.js";
export type { ServedModel, ServeOptions, LocalServer } from "./serve.js";
export type { ModelStatus } from "../cli/modelPool.js";
export type { Result } from "./result.js";

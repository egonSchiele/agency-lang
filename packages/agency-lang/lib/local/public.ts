// The public surface a TypeScript program imports to use local models
// with no `.agency` file:
//   import { listModels, generateImage, tagImage } from "agency-lang/local";
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
export type { Result } from "./result.js";

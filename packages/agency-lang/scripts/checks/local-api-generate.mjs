// A check against real models, run by hand. It calls generateImage and
// tagImage from the built package and writes the picture to a folder.
//
//   make
//   agency local serve z-image-turbo wd14-tagger
//   node scripts/checks/local-api-generate.mjs [output folder]
//
// MODEL and TAGGER choose other models. MLX_BASE_URL chooses another
// server address.
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { generateImage, tagImage } from "agency-lang/local";

const outputFolder = process.argv[2] ?? "local-api-check";
const imageModel = process.env.MODEL ?? "z-image-turbo";
const taggingModel = process.env.TAGGER ?? "wd14-tagger";

const started = Date.now();
const generated = await generateImage({
  model: imageModel,
  prompt: "a lighthouse in a storm",
  size: "1024x1024",
});
if (!generated.success) {
  console.error(generated.error);
  process.exit(1);
}
mkdirSync(outputFolder, { recursive: true });
const file = path.join(outputFolder, "lighthouse.png");
writeFileSync(file, generated.value.bytes);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`Wrote ${file} in ${seconds} s, seed ${generated.value.seed}.`);

const tags = await tagImage({ model: taggingModel, image: generated.value.bytes });
if (!tags.success) {
  console.error(tags.error);
  process.exit(1);
}
console.log(`Tags: ${tags.value.map((tag) => tag.tag).join(", ")}`);

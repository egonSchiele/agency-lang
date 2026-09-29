/** About how long a run takes, worked out from its settings alone. It is
 *  computed before `lora::train` is raised, when nothing may read the
 *  images folder, so it leaves out the few seconds an image the trainer
 *  spends preparing each picture. The estimate is for the person
 *  approving the run, not a promise. */

/** The measured rate on an M5 Ultra at 1024x1024: about 0.8 s a step,
 *  with the cost growing with the pixel count. */
const SECONDS_PER_STEP_AT_1024 = 0.8;
const SECONDS_PER_SAMPLE_IMAGE = 10.0;

/** How many times the sample grids are rendered: once before training,
 *  once every `sampleEvery` steps, and once at the end. None when
 *  `sampleEvery` is 0. */
function sampleRounds(steps: number, sampleEvery: number): number {
  if (sampleEvery <= 0) {
    return 0;
  }
  const rounds = 1 + Math.floor(steps / sampleEvery);
  return steps % sampleEvery === 0 ? rounds : rounds + 1;
}

/** Minutes, to one decimal place. Each grid row renders two images, one
 *  without the adapter and one with it. */
export function estimateMinutes(
  steps: number,
  resolution: number,
  samplePrompts: string[],
  sampleEvery: number,
): number {
  const pixels = (resolution / 1024) ** 2;
  const training = steps * SECONDS_PER_STEP_AT_1024 * pixels;
  const samples =
    sampleRounds(steps, sampleEvery) * 2 * samplePrompts.length * SECONDS_PER_SAMPLE_IMAGE * pixels;
  return Math.round((training + samples) / 6) / 10;
}

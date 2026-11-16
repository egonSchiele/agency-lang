import {
  main,
  slow,
  timeline,
  approve,
  isPaused,
  respondToInterrupts,
  resumeFromCheckpoint,
  rewindFrom,
} from "./agent.js";
import { writeFileSync } from "fs";

// Run the node with a callback, then answer its interrupt with `resumeOptions`.
// `resumeOptions` is built from one recorder per place a resume takes callbacks.
// Returns what each recorder heard, in order.
async function run(buildResumeOptions) {
  const heard = { node: [], topLevel: [], metadata: [] };
  const recorder = (name) => ({ onEmit: (data) => heard[name].push(data) });

  const first = await main({ callbacks: recorder("node") });
  const responses = first.data.map(() => approve());
  const resumed = await respondToInterrupts(
    first.data,
    responses,
    buildResumeOptions(recorder),
  );
  return { result: resumed.data, heard };
}

// 1. A resume with no callbacks. The node call's callbacks do not carry over.
const none = await run(() => undefined);

// 2. Callbacks at the top level of the resume options, where `main` takes them.
const topLevel = await run((recorder) => ({ callbacks: recorder("topLevel") }));

// 3. The older place, under `metadata`, still works.
const metadata = await run((recorder) => ({
  metadata: { callbacks: recorder("metadata") },
}));

// 4. Both places at once: both sets fire.
const both = await run((recorder) => ({
  callbacks: recorder("topLevel"),
  metadata: { callbacks: recorder("metadata") },
}));

// 5. resumeFromCheckpoint takes the same option. The pause fires inside the
// program's 400ms sleep, so the resumed leg has one `emit` left to hear.
const PAUSE_AFTER_MS = 200;
const pause = new AbortController();
setTimeout(() => pause.abort(), PAUSE_AFTER_MS);
const paused = await slow({ pauseSignal: pause.signal });
const heardAfterPause = [];
const finished = isPaused(paused.data)
  ? await resumeFromCheckpoint(paused.data, {
      callbacks: { onEmit: (data) => heardAfterPause.push(data) },
    })
  : paused;

// 6. rewindFrom takes it too. The replay starts at the checkpoint, so it
// hears the `emit` after it.
const whole = await timeline();
const heardOnRewind = [];
const replayed = await rewindFrom(whole.data.cp, {}, {
  callbacks: { onEmit: (data) => heardOnRewind.push(data) },
});

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      none,
      topLevel,
      metadata,
      both,
      resumeFromCheckpoint: {
        wasPaused: isPaused(paused.data),
        result: finished.data,
        heard: heardAfterPause,
      },
      rewindFrom: { result: replayed.data.value, heard: heardOnRewind },
    },
    null,
    2,
  ),
);

import { paused, pausedTwice, approve, reject, respondToInterrupts } from "./agent.js";
import { bumpCount, reset } from "./counter.js";
import { writeFileSync } from "fs";

// A ? operand that raises an unhandled interrupt pauses the program. The
// checkpoint is JSON round-tripped before each resume, the way a host that
// stores it would, and the operand must run exactly once per pause.
const roundTrip = (interrupts) => JSON.parse(JSON.stringify(interrupts));

reset();
const first = await paused();
const firstInterrupts = roundTrip(first.data);
const approved = await respondToInterrupts(firstInterrupts, firstInterrupts.map(() => approve()));
const approvedBumps = bumpCount();

reset();
const second = await paused();
const secondInterrupts = roundTrip(second.data);
const rejected = await respondToInterrupts(secondInterrupts, secondInterrupts.map(() => reject("no")));
const rejectedBumps = bumpCount();

reset();
const twice = await pausedTwice();
const twiceFirst = roundTrip(twice.data);
const afterFirst = await respondToInterrupts(twiceFirst, twiceFirst.map(() => approve()));
const twiceSecond = roundTrip(afterFirst.data);
const afterSecond = await respondToInterrupts(twiceSecond, twiceSecond.map(() => approve()));
const twiceBumps = bumpCount();

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      firstInterrupted: Array.isArray(first.data) && first.data.length === 1,
      firstEffect: first.data[0]?.effect,
      approvedValue: approved.data?.value,
      approvedBumps,
      rejectedIsFailure: rejected.data?.success === false,
      rejectedMessageHasReason: typeof rejected.data?.error === "string" && rejected.data.error.includes("no"),
      rejectedFlag: rejected.data?.rejected,
      rejectedBumps,
      secondInterruptN: twiceSecond[0]?.data?.n,
      twiceValue: afterSecond.data?.value,
      twiceBumps,
    },
    null,
    2,
  ),
);

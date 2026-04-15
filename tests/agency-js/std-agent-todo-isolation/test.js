import { writeFileSync } from "fs";
import { writeAndList, justList } from "./agent.js";

// Run A writes a todo.
const a = await writeAndList("from run A");

// Run B writes a different todo.
const b = await writeAndList("from run B");

// Run C does not write, so its todo list should be empty if per-run isolation works.
const c = await justList();

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      a: a.data.map((t) => t.text),
      b: b.data.map((t) => t.text),
      cIsEmpty: c.data.length === 0,
    },
    null,
    2,
  ),
);

import { foo } from "./foo.ts";
import { sayHi } from "./bar.ts";
import { toolMessage } from "smoltalk";

type Interrupt<T> = {
  type: "interrupt";
  data: T;
  __messages: any[];
  __toolCall: {
    id: string;
    name: string;
  };
};

function isInterrupt<T>(obj: any): obj is Interrupt<T> {
  return obj && obj.type === "interrupt";
}

const finalState = (await foo()) as any;
console.log(finalState);
if (isInterrupt(finalState)) {
  console.log("Execution interrupted with message:", finalState.data);
  const messages = finalState.__messages;
  messages.push(
    toolMessage("guten tag dave!", {
      tool_call_id: finalState.__toolCall.id,
      name: finalState.__toolCall.name,
    }),
  );
  await sayHi("Dave", { messages });
}

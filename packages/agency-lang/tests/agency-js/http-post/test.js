import { postCreate, getData, postRaw, callPost, callPfaGet, hasInterrupts } from "./agent.js";
import { writeFileSync } from "node:fs";

const unwrap = (r) => r?.data ?? r;

// --- interrupt payload assertions (throw on mismatch) ---

// (A) The std::http::fetchJSON interrupt payload carries `method` — the field a std::policy rule
// matches on to allow GET and deny POST.
const i1 = await callPost();
if (!hasInterrupts(i1.data)) throw new Error("callPost did not raise an interrupt");
const iv = i1.data[0];
if (iv.effect !== "std::http::fetchJSON") throw new Error("wrong effect: " + iv.effect);
if (iv.data.method !== "POST") throw new Error("payload missing method=POST, got: " + iv.data.method);

// (B) PFA attenuation: fetchJSON.partial(method: "GET") locks the method — its raised interrupt
// reports GET even though the caller passed no method.
const p1 = await callPfaGet();
if (!hasInterrupts(p1.data)) throw new Error("callPfaGet did not raise an interrupt");
if (p1.data[0].data.method !== "GET") throw new Error("PFA did not lock method=GET, got: " + p1.data[0].data.method);

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      postCreate: unwrap(await postCreate()),
      getData: unwrap(await getData()),
      postRaw: unwrap(await postRaw()),
    },
    null,
    2,
  ),
);

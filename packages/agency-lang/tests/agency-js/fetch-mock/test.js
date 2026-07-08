import { getData, getPage } from "./agent.js";
import { writeFileSync } from "fs";

const data = await getData();
const page = await getPage();
writeFileSync("__result.json", JSON.stringify({ value: data.data, page: page.data }, null, 2));

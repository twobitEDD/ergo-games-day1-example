import { Day1Store } from "./store";
import { loadDay1Env } from "./env";

loadDay1Env();

const store = new Day1Store();
store.close();
console.log("[day1-db] initialized schema");

import { register } from "tsx/esm/api";
import { pathToFileURL } from "node:url";

// Keep the app in the process nodemon supervises. The tsx CLI spawns another
// Node process; a restart can observe the CLI exit while that app still serves
// requests or consumes jobs with yesterday's prompts.
register();
const entry = process.argv[2];
if (!entry) throw new Error("Missing development app entry point.");
process.argv.splice(1, 1);
await import(pathToFileURL(entry).href);

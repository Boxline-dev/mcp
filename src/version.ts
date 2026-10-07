import { readFileSync } from "node:fs";

/** The package's version, read from package.json (next to `src/` and `dist/`), so it can never drift from the release. */
export const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

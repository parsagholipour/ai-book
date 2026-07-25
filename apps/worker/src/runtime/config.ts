import { loadConfig } from "@book-maker/core";

/**
 * Single parsed copy of the worker environment. `loadConfig` only reads and
 * validates env vars, so importing this module has no side effects beyond
 * throwing on invalid configuration at startup.
 */
export const config = loadConfig();

/**
 * Shared libsodium import.
 *
 * libsodium-wrappers v0.7.x has a broken ESM entry point (relative import
 * to a file in a sibling package). Force CJS resolution which works correctly.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as typeof import("libsodium-wrappers");
export default sodium;

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;
export type SQLInputValue = import("node:sqlite").SQLInputValue;

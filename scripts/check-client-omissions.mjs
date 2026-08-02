#!/usr/bin/env node
/* global process */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertClientOmissionPolicy } from "./lib/client-codegen.mjs";

const prefix = "--as-of=";
const rawAuthority = process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
if (!rawAuthority) {
  throw new Error("Client omission policy requires explicit --as-of=YYYY-MM-DD or --as-of=current authority.");
}
const asOf = rawAuthority === "current"
  ? new Date().toISOString().slice(0, 10)
  : rawAuthority;
const sourceBytes = await readFile(resolve(process.cwd(), "calyx-openapi.json"));
assertClientOmissionPolicy(sourceBytes, asOf);
process.stdout.write(`calyx-client omission policy valid as of ${asOf}\n`);

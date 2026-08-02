#!/usr/bin/env node
/* global process */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { renderCalyxOpenApi } from "../packages/server/dist/index.js";

const output = resolve(process.cwd(), "calyx-openapi.json");
await writeFile(output, renderCalyxOpenApi(), "utf8");
process.stdout.write(`${output}\n`);

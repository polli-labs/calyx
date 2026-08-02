#!/usr/bin/env node
/* global process */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compileClientContract } from "./lib/client-codegen.mjs";

const sourcePath = resolve(process.cwd(), "calyx-openapi.json");
const sourceBytes = await readFile(sourcePath);
const renders = await Promise.all(Array.from({ length: 5 }, () => compileClientContract(sourceBytes)));
const first = renders[0];
if (!first) throw new Error("Client contract compiler produced no render.");
for (const render of renders.slice(1)) {
  if (JSON.stringify(render) !== JSON.stringify(first)) {
    throw new Error("Client generation was not byte-identical across five consecutive renders.");
  }
}
for (const [relativePath, content] of Object.entries(first.files)) {
  await writeFile(resolve(process.cwd(), relativePath), content, "utf8");
}
process.stdout.write(
  `calyx-client contract ${first.digest} (${first.byteCount} OpenAPI bytes; consumer=${first.counts.consumer}; admin=${first.counts.admin})\n`,
);

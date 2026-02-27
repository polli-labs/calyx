#!/usr/bin/env node
import { runCli } from "./run-cli";

runCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode =
    error && typeof error === "object" && "exitCode" in error && typeof error.exitCode === "number"
      ? error.exitCode
      : 1;
  console.error(message);
  process.exitCode = exitCode;
});

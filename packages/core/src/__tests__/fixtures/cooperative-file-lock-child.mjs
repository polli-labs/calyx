import { acquireCooperativeFileLock } from "../../cooperative-file-lock.ts";
import process from "node:process";

const [lockPath] = process.argv.slice(2);

try {
  const lock = await acquireCooperativeFileLock({ lockPath });
  process.send?.({
    type: "acquired",
    ownerToken: lock.ownerToken,
    pid: process.pid,
  });
  process.on("message", async (message) => {
    if (message?.type !== "release") return;
    try {
      const result = await lock.release();
      process.send?.({ type: "released", result });
      process.exit(0);
    } catch (error) {
      process.send?.({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  });
} catch (error) {
  process.send?.({
    type: "error",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}

import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { drainMessageReceiptMirrors, openStateStore } from "../../state";

const [messageId, readyPath, gatePath] = process.argv.slice(2);
if (!messageId || !readyPath || !gatePath) {
  throw new Error("usage: message-receipt-worker <message-id> <ready-path> <gate-path>");
}

const opened = await openStateStore();
try {
  await writeFile(readyPath, `${process.pid}\n`, "utf8");
  while (true) {
    try {
      await access(gatePath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(5);
    }
  }
  const result = await drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
    message_id: messageId,
    force: true,
    limit: 1,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  opened.db.close();
}

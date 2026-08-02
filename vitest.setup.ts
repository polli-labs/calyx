import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["CALYX_TEST_STATE_GUARD"] = "1";

if (!process.env["CALYX_STATE_HOME"]?.trim() && !process.env["CALYX_STATE_DB"]?.trim()) {
  process.env["CALYX_STATE_HOME"] = mkdtempSync(join(tmpdir(), `calyx-vitest-state-${process.pid}-`));
}

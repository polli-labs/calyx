import { describe, expect, it } from "vitest";
import {
  buildCalyxRunMetadataEnv,
  mergeBackendOptionsWithCalyxRunMetadataEnv,
} from "../src/run-metadata-env.js";

describe("Calyx run metadata env", () => {
  it("builds stable CALYX_RUN metadata variables when values exist", () => {
    expect(buildCalyxRunMetadataEnv({
      run_id: "run-1324",
      run_dir: "/tmp/runs/run-1324",
      host: "blade",
      issue: "POL-1324",
      worktree: "/tmp/worktrees/pol-1324",
    })).toEqual({
      CALYX_RUN_ID: "run-1324",
      CALYX_RUN_DIR: "/tmp/runs/run-1324",
      CALYX_RUN_HOST: "blade",
      CALYX_RUN_ISSUE: "POL-1324",
      CALYX_RUN_WORKTREE: "/tmp/worktrees/pol-1324",
    });
  });

  it("omits empty metadata values", () => {
    expect(buildCalyxRunMetadataEnv({
      run_id: " ",
      host: "blade",
      issue: "",
    })).toEqual({
      CALYX_RUN_HOST: "blade",
    });
  });

  it("merges with backend env while protecting Calyx identity keys", () => {
    const merged = mergeBackendOptionsWithCalyxRunMetadataEnv(
      {
        env: {
          CALYX_RUN_ID: "forged-run",
          CALYX_RUN_DIR: null,
          CUSTOM_VAR: "kept",
          REMOVE_ME: null,
        },
        custom_backend_field: "preserved",
      },
      {
        CALYX_RUN_ID: "run-1324",
        CALYX_RUN_DIR: "/tmp/runs/run-1324",
        CALYX_RUN_HOST: "blade",
      },
    );

    expect(merged).toEqual({
      env: {
        CALYX_RUN_ID: "run-1324",
        CALYX_RUN_DIR: "/tmp/runs/run-1324",
        CALYX_RUN_HOST: "blade",
        CUSTOM_VAR: "kept",
        REMOVE_ME: null,
      },
      custom_backend_field: "preserved",
    });
  });
});

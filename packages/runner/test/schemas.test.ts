import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  runStateSchema,
  failureClassSchema,
  failureSourceSchema,
  runSpecSchema,
  lifecycleEventSchema,
  artifactManifestSchema,
  runReceiptSchema,
  receiptTimingSchema,
  dispatchReceiptSchema,
} from "@polli-labs/calyx-runner";

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../fixtures/domains/runner");

async function readFixture<T>(name: string): Promise<T> {
  const raw = await readFile(resolve(FIXTURE_DIR, name), "utf8");
  return JSON.parse(raw) as T;
}

// ── Enum schemas ────────────────────────────────────────────────────

describe("runStateSchema", () => {
  const validStates = [
    "queued", "dispatching", "running", "succeeded",
    "failed", "partial", "cancelled", "auth_error", "infra_error", "completed_dirty",
  ];

  test.each(validStates)("accepts %s", (state) => {
    expect(runStateSchema.parse(state)).toBe(state);
  });

  test("rejects invalid state", () => {
    expect(() => runStateSchema.parse("pending")).toThrow();
    expect(() => runStateSchema.parse("")).toThrow();
    expect(() => runStateSchema.parse(42)).toThrow();
  });
});

describe("failureClassSchema", () => {
  test("accepts all valid classes", () => {
    for (const cls of ["success", "task_failure", "auth_error", "infra_error", "completed_dirty", "dispatch_rejected"]) {
      expect(failureClassSchema.parse(cls)).toBe(cls);
    }
  });

  test("rejects invalid class", () => {
    expect(() => failureClassSchema.parse("unknown")).toThrow();
  });
});

describe("failureSourceSchema", () => {
  test("accepts all valid sources", () => {
    for (const src of ["exit_code", "backend_event", "stderr_pattern", "heuristic", "dispatch_gate"]) {
      expect(failureSourceSchema.parse(src)).toBe(src);
    }
  });
});

// ── RunSpec schema ──────────────────────────────────────────────────

describe("runSpecSchema", () => {
  test("parses valid fixture", async () => {
    const fixture = await readFixture("run-spec.valid.json");
    const result = runSpecSchema.parse(fixture);
    expect(result.host).toBe("blade");
    expect(result.backend).toBe("codex");
    expect(result.worktree.ref).toBe("origin/main");
    expect(result.worktree.steal_lock).toBe(false);
  });

  test("applies defaults for worktree", () => {
    const minimal = {
      host: "local",
      backend: "codex" as const,
      prompt: "hello",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    };
    const result = runSpecSchema.parse(minimal);
    expect(result.worktree.ref).toBe("origin/main");
    expect(result.worktree.steal_lock).toBe(false);
  });

  test("accepts terminal handback binding", () => {
    const result = runSpecSchema.parse({
      host: "local",
      backend: "codex",
      prompt: "hello",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
      handback: {
        key: "review:standard:repo:pr-223",
        recipient_address: "interactive:codex:caller",
        recipient_host: "blade",
        thread_key: "review:standard:repo:pr-223",
        ack_required: true,
        body_contract: "locators only",
        subject: "review handback",
        flow: "calyx.msg/v1",
        idempotency_key: "handback:run-1:review:standard:repo:pr-223",
      },
    });
    expect(result.handback).toMatchObject({
      recipient_address: "interactive:codex:caller",
      ack_required: true,
      flow: "calyx.msg/v1",
    });
  });

  test("rejects invalid fixtures", async () => {
    const invalids = await readFixture<Record<string, unknown>[]>("run-spec.invalid.json");
    for (const fixture of invalids) {
      const desc = fixture._description as string;
      const data = Object.fromEntries(
        Object.entries(fixture).filter(([k]) => k !== "_description"),
      );
      expect(() => runSpecSchema.parse(data), `should reject: ${desc}`).toThrow();
    }
  });

  test("validates issue format", () => {
    expect(() =>
      runSpecSchema.parse({
        host: "local",
        backend: "claude",
        issue: "lowercase-123",
        prompt: "test",
        require_execplan: false,
        pull_execplan: false,
        worktree: {},
      }),
    ).toThrow();
  });

  test("accepts non-UUID run_id values used by async runner", () => {
    const result = runSpecSchema.parse({
      run_id: "20260303T221706Z-f327532e",
      host: "local",
      backend: "codex",
      prompt: "test",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    });
    expect(result.run_id).toBe("20260303T221706Z-f327532e");
  });

  test("rejects empty run_id", () => {
    expect(() =>
      runSpecSchema.parse({
        run_id: "",
        host: "local",
        backend: "claude",
        prompt: "test",
        require_execplan: false,
        pull_execplan: false,
        worktree: {},
      }),
    ).toThrow();
  });

  test("backend_options passthrough preserves unknown fields", () => {
    const result = runSpecSchema.parse({
      host: "local",
      backend: "codex",
      prompt: "test",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
      backend_options: {
        max_threads: 2,
        custom_field: "preserved",
      },
    });
    expect((result.backend_options as Record<string, unknown>)?.custom_field).toBe("preserved");
  });

  test("backend_options accepts supported Codex sandbox modes and rejects typos", () => {
    const spec = {
      host: "local",
      backend: "codex",
      prompt: "test",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    } as const;

    expect(runSpecSchema.parse({
      ...spec,
      backend_options: { sandbox: "read-only" },
    }).backend_options?.sandbox).toBe("read-only");
    expect(runSpecSchema.parse({
      ...spec,
      backend_options: { sandbox: "danger-full-access" },
    }).backend_options?.sandbox).toBe("danger-full-access");
    expect(() => runSpecSchema.parse({
      ...spec,
      backend_options: { sandbox: "readonly" },
    })).toThrow();
    expect(() => runSpecSchema.parse({
      ...spec,
      backend_options: { sandbox: "read-only", dangerously_skip_permissions: true },
    })).toThrow("sandbox=read-only conflicts with dangerously_skip_permissions=true");
    expect(() => runSpecSchema.parse({
      ...spec,
      backend: "claude",
      backend_options: { sandbox: "read-only" },
    })).toThrow("Claude does not support backend_options.sandbox");
  });

  test.each(["PATH", "HOME", "CODEX_HOME", "NODE_OPTIONS", "OPENAI_API_KEY", "CODEX_CONFIG"])(
    "typed output capture rejects user-supplied backend env key %s",
    (key) => {
      expect(() => runSpecSchema.parse({
        host: "local",
        backend: "codex",
        prompt: "return JSON",
        require_execplan: false,
        pull_execplan: false,
        worktree: {},
        output_capture: {
          name: "result.json",
          source: "agent_terminal_message",
          media_type: "application/json",
          schema: { type: "object" },
          max_bytes: 4096,
          required: true,
        },
        backend_options: {
          sandbox: "read-only",
          env: { [key]: "forged" },
        },
      })).toThrow("output_capture does not accept backend_options.env");
    },
  );

  test("backend_options keeps concurrency and turn limits backend-specific", () => {
    const claude = runSpecSchema.parse({
      host: "local",
      backend: "claude",
      prompt: "test",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
      backend_options: { max_turns: 4 },
    });
    const codex = runSpecSchema.parse({
      host: "local",
      backend: "codex",
      prompt: "test",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
      backend_options: { max_threads: 4 },
    });

    expect(claude.backend_options).toMatchObject({ max_turns: 4 });
    expect(codex.backend_options).toMatchObject({ max_threads: 4 });
    expect(() => runSpecSchema.parse({ ...claude, backend_options: { max_threads: 4 } }))
      .toThrow("Claude does not support backend_options.max_threads");
    expect(() => runSpecSchema.parse({ ...codex, backend_options: { max_turns: 4 } }))
      .toThrow("Codex does not support backend_options.max_turns");
  });

  test("backend_options accepts backend-native reasoning efforts", () => {
    const claude = runSpecSchema.parse({
      host: "local",
      backend: "claude",
      prompt: "test",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
      backend_options: {
        reasoning_effort: "max",
      },
    });
    const codex = runSpecSchema.parse({
      host: "local",
      backend: "codex",
      prompt: "test",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
      backend_options: {
        reasoning_effort: "minimal",
      },
    });

    expect(claude.backend_options?.reasoning_effort).toBe("max");
    expect(codex.backend_options?.reasoning_effort).toBe("minimal");
  });

  test("backend_options accepts model selection", () => {
    const result = runSpecSchema.parse({
      host: "local",
      backend: "claude",
      prompt: "test",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
      backend_options: {
        model: "opus",
      },
    });

    expect(result.backend_options?.model).toBe("opus");
  });

  test("agent_activity config can rely on the default stale window", () => {
    const result = runSpecSchema.parse({
      host: "local",
      backend: "claude",
      prompt: "test",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
      backend_options: {
        agent_activity: {
          hard_timeout_ms: 120000,
        },
      },
    });

    expect(result.backend_options?.agent_activity).toEqual({
      hard_timeout_ms: 120000,
    });
  });

  test("accepts system prompt fields on RunSpec", () => {
    const result = runSpecSchema.parse({
      host: "local",
      backend: "codex",
      prompt: "test",
      system_prompt: "Replacement base instructions.",
      append_system_prompt: "Additional developer instructions.",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    });
    expect(result.system_prompt).toBe("Replacement base instructions.");
    expect(result.append_system_prompt).toBe("Additional developer instructions.");
  });
});

// ── LifecycleEvent schema ───────────────────────────────────────────

describe("lifecycleEventSchema", () => {
  test("parses valid event", () => {
    const event = {
      timestamp: "2026-03-01T10:00:00.000Z",
      run_id: "550e8400-e29b-41d4-a716-446655440000",
      event: "state_transition",
      from: "queued",
      to: "dispatching",
      message: "Dispatch started",
    };
    const result = lifecycleEventSchema.parse(event);
    expect(result.event).toBe("state_transition");
    expect(result.from).toBe("queued");
  });

  test("rejects invalid timestamp", () => {
    expect(() =>
      lifecycleEventSchema.parse({
        timestamp: "not-a-date",
        run_id: "550e8400-e29b-41d4-a716-446655440000",
        event: "error",
      }),
    ).toThrow();
  });
});

// ── ArtifactManifest schema ─────────────────────────────────────────

describe("artifactManifestSchema", () => {
  test("parses valid manifest", () => {
    const manifest = {
      run_id: "550e8400-e29b-41d4-a716-446655440000",
      finalized_at: "2026-03-01T10:05:00.000Z",
      required: [
        {
          name: "receipt.json",
          location: "run_dir",
          path: "/tmp/receipt.json",
          required: true,
          detected_at: "2026-03-01T10:04:59.000Z",
        },
      ],
      discovered: [],
      gate_passed: true,
      missing: [],
    };
    expect(artifactManifestSchema.parse(manifest).gate_passed).toBe(true);
  });

  test("validates sha256 format", () => {
    expect(() =>
      artifactManifestSchema.parse({
        run_id: "550e8400-e29b-41d4-a716-446655440000",
        finalized_at: "2026-03-01T10:05:00.000Z",
        required: [
          {
            name: "f",
            location: "run_dir",
            path: "/tmp/f",
            sha256: "not-a-hash",
            required: true,
            detected_at: "2026-03-01T10:04:59.000Z",
          },
        ],
        discovered: [],
        gate_passed: true,
        missing: [],
      }),
    ).toThrow();
  });
});

// ── RunReceipt schema ───────────────────────────────────────────────

describe("runReceiptSchema", () => {
  test("parses valid fixture", async () => {
    const fixture = await readFixture("receipt.valid.json");
    const result = runReceiptSchema.parse(fixture);
    expect(result.schema_version).toBe("1.0");
    expect(result.state).toBe("succeeded");
    expect(result.timing.duration_ms).toBe(300000);
    expect(result.artifacts.gate_passed).toBe(true);
    expect(result.summary).toBeTruthy();
  });

  test("rejects invalid schema_version", () => {
    expect(() =>
      runReceiptSchema.parse({
        schema_version: "2.0",
        run_id: "550e8400-e29b-41d4-a716-446655440000",
        state: "succeeded",
        run_spec: {
          host: "local",
          backend: "claude",
          prompt: "x",
          require_execplan: false,
          pull_execplan: false,
          worktree: {},
        },
        timing: {
          created_at: "2026-03-01T10:00:00.000Z",
          completed_at: "2026-03-01T10:05:00.000Z",
        },
        exit: {},
        artifacts: {
          run_id: "550e8400-e29b-41d4-a716-446655440000",
          finalized_at: "2026-03-01T10:05:00.000Z",
          required: [],
          discovered: [],
          gate_passed: true,
          missing: [],
        },
        log_summary: { total: 0, info: 0, warn: 0, error: 0 },
        environment: { host: "local", backend: "claude" },
        summary: "ok",
      }),
    ).toThrow();
  });
});

describe("receiptTimingSchema", () => {
  const validTiming = {
    created_at: "2026-07-14T10:00:00.000Z",
    dispatched_at: "2026-07-14T10:00:01.000Z",
    started_at: "2026-07-14T10:00:02.000Z",
    completed_at: "2026-07-14T10:00:05.000Z",
    duration_ms: 5_000,
    dispatch_duration_ms: 1_000,
    backend_duration_ms: 2_500,
  };

  test("accepts chronological timing with documented duration tolerance", () => {
    expect(receiptTimingSchema.parse({ ...validTiming, duration_ms: 5_999 })).toMatchObject({
      ...validTiming,
      duration_ms: 5_999,
    });
  });

  test("rejects an inverted optional stage chain", () => {
    const parsed = receiptTimingSchema.safeParse({
      ...validTiming,
      started_at: "2026-07-14T10:00:00.500Z",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toContainEqual(expect.objectContaining({ path: ["started_at"] }));
  });

  test("rejects durations that do not correspond to timestamps", () => {
    expect(receiptTimingSchema.safeParse({ ...validTiming, duration_ms: 60_000 }).success).toBe(false);
    expect(receiptTimingSchema.safeParse({ ...validTiming, dispatch_duration_ms: 60_000 }).success).toBe(false);
    expect(receiptTimingSchema.safeParse({ ...validTiming, backend_duration_ms: 60_000 }).success).toBe(false);
  });
});

// ── DispatchReceipt schema ──────────────────────────────────────────

describe("dispatchReceiptSchema", () => {
  test("parses valid dispatch receipt", () => {
    const receipt = {
      dispatch_id: "550e8400-e29b-41d4-a716-446655440001",
      run_id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-03-01T10:00:00.000Z",
      decision: "accepted",
      lane: "execplan",
      overridden: false,
      checks: [
        { name: "prompt_resolved", passed: true, message: "Prompt resolved from file" },
      ],
      warnings: [],
    };
    const result = dispatchReceiptSchema.parse(receipt);
    expect(result.decision).toBe("accepted");
    expect(result.checks).toHaveLength(1);
  });
});

// ── Typed terminal output capture ─────────────────────────────────

describe("runSpecSchema output_capture", () => {
  const capture = {
    name: "proposal.json",
    source: "agent_terminal_message" as const,
    media_type: "application/json" as const,
    schema: {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    },
    max_bytes: 8192,
    required: true as const,
  };
  const base = {
    host: "local",
    backend: "codex" as const,
    prompt: "Return structured output.",
    require_execplan: false,
    pull_execplan: false,
    worktree: {},
    backend_options: { sandbox: "read-only" as const },
    output_capture: capture,
  };

  test("accepts the proven single-turn Codex read-only contract", () => {
    expect(runSpecSchema.parse(base)).toMatchObject({
      backend: "codex",
      output_capture: capture,
      backend_options: { sandbox: "read-only" },
    });
  });

  test.each([
    ["absolute", "/tmp/proposal.json"],
    ["traversal", "../proposal.json"],
    ["nested", "nested/proposal.json"],
    ["backslash", "nested\\proposal.json"],
    ["dot", "."],
    ["dot-dot", ".."],
  ])("rejects an unsafe %s output basename", (_label, name) => {
    expect(() => runSpecSchema.parse({
      ...base,
      output_capture: { ...capture, name },
    })).toThrow("safe basename");
  });

  test("rejects a non-Codex backend", () => {
    expect(() => runSpecSchema.parse({
      ...base,
      backend: "claude",
      backend_options: {},
    })).toThrow("requires backend=codex");
  });

  test.each([
    ["missing sandbox", {}],
    ["writable sandbox", { sandbox: "danger-full-access" }],
  ])("rejects %s", (_label, backendOptions) => {
    expect(() => runSpecSchema.parse({
      ...base,
      backend_options: backendOptions,
    })).toThrow("sandbox=read-only");
  });

  test("rejects provider tool allowlists even when empty", () => {
    expect(() => runSpecSchema.parse({
      ...base,
      backend_options: { sandbox: "read-only", allowed_tools: [] },
    })).toThrow("does not accept provider tool allowlists");
  });

  test("rejects resume and multi-turn execution", () => {
    expect(() => runSpecSchema.parse({
      ...base,
      resume_session_id: "session-prior",
    })).toThrow("cannot resume");
    expect(() => runSpecSchema.parse({
      ...base,
      max_turns_per_run: 2,
    })).toThrow("exactly one");
  });

  test("keeps typed capture distinct from legacy required artifacts", () => {
    expect(() => runSpecSchema.parse({
      ...base,
      required_artifacts: ["proposal.json"],
    })).toThrow("must not also appear");
  });

  test("requires the complete closed capture shape", () => {
    const missingLimit: Record<string, unknown> = { ...capture };
    delete missingLimit.max_bytes;
    expect(() => runSpecSchema.parse({
      ...base,
      output_capture: missingLimit,
    })).toThrow();
    expect(() => runSpecSchema.parse({
      ...base,
      output_capture: { ...capture, unexpected: true },
    })).toThrow();
  });

  test.each([null, true, 42, "object", []])(
    "rejects a non-object JSON Schema value %#",
    (schema) => {
      expect(() => runSpecSchema.parse({
        ...base,
        output_capture: { ...capture, schema },
      })).toThrow();
    },
  );
});

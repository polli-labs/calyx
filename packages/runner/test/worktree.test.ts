import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { acquireWorktree } from "../src/worktree.js";

function mockGitWorktreeAdd() {
  return vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === "show-ref") {
      // Default: branch does not exist, so acquireWorktree uses `-b`.
      return { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "remote") {
      return { code: 0, stdout: "origin\n", stderr: "" };
    }
    if (args[0] === "fetch") {
      return { code: 0, stdout: "", stderr: "" };
    }
    const worktreePath = args.at(-2);
    if (worktreePath) {
      await mkdir(worktreePath, { recursive: true });
    }
    return { code: 0, stdout: "", stderr: "" };
  });
}

describe("acquireWorktree", () => {
  const created: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    created.length = 0;
  });

  test("skips base-path validation for an explicit worktree path", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-explicit-"));
    created.push(root);
    const explicitPath = join(root, "existing");
    await mkdir(explicitPath, { recursive: true });
    const exec = mockGitWorktreeAdd();

    const result = await acquireWorktree(
      { path: explicitPath, ref: "origin/main" },
      "run-explicit-1",
      { base_path: join(root, "not-a-repo"), exec },
    );

    expect(result.acquired).toBe(true);
    expect(result.path).toBe(explicitPath);
    expect(exec).not.toHaveBeenCalled();
  });

  test("fails fast when worktree base is not inside a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-no-repo-"));
    created.push(root);
    const basePath = join(root, "projects");
    const exec = mockGitWorktreeAdd();

    const result = await acquireWorktree(
      { branch: "caleb/pol-1101", ref: "origin/main" },
      "run-invalid-base",
      { base_path: basePath, exec },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain(`Worktree base ${basePath} is not a git repository.`);
    expect(result.error).toContain("Pass --worktree-path <absolute-path> explicitly");
    expect(result.error).toContain("You can also pass --repo <slug>");
    expect(exec).not.toHaveBeenCalled();
  });

  test("proceeds when worktree base is nested under a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-git-base-"));
    created.push(root);
    await mkdir(join(root, ".git"), { recursive: true });
    const exec = mockGitWorktreeAdd();
    const basePath = join(root, "worktrees");

    const result = await acquireWorktree(
      { branch: "caleb/pol-1101", ref: "origin/main" },
      "run-valid-base",
      { base_path: basePath, exec },
    );

    expect(result.acquired).toBe(true);
    expect(result.path).toBe(join(basePath, "caleb/pol-1101"));
    expect(exec).toHaveBeenCalledWith("git", [
      "worktree",
      "add",
      "-b",
      "caleb/pol-1101",
      join(basePath, "caleb/pol-1101"),
      "origin/main",
    ], undefined);
  });

  test("resolves repo slugs to clean clone worktree bases and runs git from the clean clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-repo-slug-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    const exec = mockGitWorktreeAdd();

    const result = await acquireWorktree(
      { repo: "calyx", branch: "caleb/pol-1101", ref: "origin/main" },
      "run-repo-base",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(true);
    expect(result.path).toBe(join(root, "dev", "calyx", "wt", "caleb/pol-1101"));
    expect(exec).toHaveBeenCalledWith("git", [
      "worktree",
      "add",
      "-b",
      "caleb/pol-1101",
      join(root, "dev", "calyx", "wt", "caleb/pol-1101"),
      "origin/main",
    ], { cwd: repoPath });
  });

  test("rejects a missing explicit worktree path", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-missing-"));
    created.push(root);
    const exec = mockGitWorktreeAdd();

    const result = await acquireWorktree(
      { path: join(root, "missing"), ref: "origin/main" },
      "run-explicit-missing",
      { base_path: root, exec },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("does not exist");
    expect(result.error).toContain("omit --worktree-path");
    expect(result.error).toContain("--worktree-mode create");
    expect(exec).not.toHaveBeenCalled();
  });

  test("refuses a worktree when its DB lease is held by another holder", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-db-lease-held-"));
    created.push(root);
    const explicitPath = join(root, "existing");
    await mkdir(explicitPath, { recursive: true });
    const exec = mockGitWorktreeAdd();
    const release = vi.fn();
    const lease = {
      acquire: vi.fn(async () => ({
        acquired: false,
        error: "lease held by run:first until 2026-06-12T00:00:00.000Z",
      })),
      release,
    };

    const result = await acquireWorktree(
      { path: explicitPath, ref: "origin/main" },
      "run-second",
      { base_path: root, exec, lease, contention_retry: { attempts: 1 } },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("lease held by run:first");
    expect(lease.acquire).toHaveBeenCalledWith({
      path: explicitPath,
      run_id: "run-second",
      ttl_ms: 30 * 60 * 1000,
      steal_lock: false,
    });
    expect(release).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  test("releases an acquired DB lease when the crash-safety file lock blocks acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-db-lease-unwind-"));
    created.push(root);
    const explicitPath = join(root, "existing");
    await mkdir(explicitPath, { recursive: true });
    await writeFile(
      join(explicitPath, ".calyx-runner.lock"),
      JSON.stringify({
        run_id: "run-file-lock",
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }),
    );
    const exec = mockGitWorktreeAdd();
    const dbLease = {
      key: `worktree:blade:${explicitPath}`,
      holder_activity_id: "run:run-second",
      ttl_ms: 30 * 60 * 1000,
      expires_at: "2026-06-12T00:30:00.000Z",
    };
    const release = vi.fn();
    const lease = {
      acquire: vi.fn(async () => ({
        acquired: true,
        lease: dbLease,
      })),
      release,
    };

    const result = await acquireWorktree(
      { path: explicitPath, ref: "origin/main" },
      "run-second",
      { base_path: root, exec, lease, contention_retry: { attempts: 1 } },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("Worktree locked by run run-file-lock");
    expect(release).toHaveBeenCalledWith(dbLease);
    expect(exec).not.toHaveBeenCalled();
  });

  test("retries transient DB lease contention and succeeds once the lease frees", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-lease-retry-"));
    created.push(root);
    const explicitPath = join(root, "existing");
    await mkdir(explicitPath, { recursive: true });
    const exec = mockGitWorktreeAdd();
    const dbLease = {
      key: `worktree:carbon:${explicitPath}`,
      holder_activity_id: "run:run-second",
      ttl_ms: 30 * 60 * 1000,
      expires_at: "2026-06-12T00:30:00.000Z",
    };
    let calls = 0;
    const lease = {
      acquire: vi.fn(async () => {
        calls += 1;
        return calls < 3
          ? { acquired: false, error: "lease held by run:first" }
          : { acquired: true, lease: dbLease };
      }),
      release: vi.fn(),
    };
    const sleep = vi.fn(async () => {});

    const result = await acquireWorktree(
      { path: explicitPath, ref: "origin/main" },
      "run-second",
      { base_path: root, exec, lease, contention_retry: { attempts: 3, sleep } },
    );

    expect(result.acquired).toBe(true);
    expect(result.lease).toEqual(dbLease);
    expect(lease.acquire).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("retries a live file lock with backoff, then surfaces remediation on exhaustion", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-lock-retry-"));
    created.push(root);
    const explicitPath = join(root, "existing");
    await mkdir(explicitPath, { recursive: true });
    await writeFile(
      join(explicitPath, ".calyx-runner.lock"),
      JSON.stringify({ run_id: "run-holder", pid: process.pid, acquired_at: new Date().toISOString() }),
    );
    const exec = mockGitWorktreeAdd();
    const dbLease = {
      key: `worktree:carbon:${explicitPath}`,
      holder_activity_id: "run:run-second",
      ttl_ms: 30 * 60 * 1000,
      expires_at: "2026-06-12T00:30:00.000Z",
    };
    const release = vi.fn();
    const lease = {
      acquire: vi.fn(async () => ({ acquired: true, lease: dbLease })),
      release,
    };
    const sleep = vi.fn(async () => {});

    const result = await acquireWorktree(
      { path: explicitPath, ref: "origin/main" },
      "run-second",
      { base_path: root, exec, lease, contention_retry: { attempts: 2, sleep } },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("Worktree locked by run run-holder");
    expect(result.error).toContain("Retried 2× with backoff");
    expect(result.error).toContain("--steal-lock");
    expect(lease.acquire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test("steal_lock bypasses contention retry and adopts the worktree immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-steal-"));
    created.push(root);
    const explicitPath = join(root, "existing");
    await mkdir(explicitPath, { recursive: true });
    await writeFile(
      join(explicitPath, ".calyx-runner.lock"),
      JSON.stringify({ run_id: "run-holder", pid: process.pid, acquired_at: new Date().toISOString() }),
    );
    const exec = mockGitWorktreeAdd();
    const sleep = vi.fn(async () => {});

    const result = await acquireWorktree(
      { path: explicitPath, ref: "origin/main", steal_lock: true },
      "run-thief",
      { base_path: root, exec, contention_retry: { attempts: 3, sleep } },
    );

    expect(result.acquired).toBe(true);
    expect(result.stolen).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("steal_lock does not retry a refused DB lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-steal-lease-"));
    created.push(root);
    const explicitPath = join(root, "existing");
    await mkdir(explicitPath, { recursive: true });
    const exec = mockGitWorktreeAdd();
    const acquire = vi.fn(async () => ({
      acquired: false,
      error: "lease worktree:carbon:/x held by run:first",
    }));
    const sleep = vi.fn(async () => {});

    const result = await acquireWorktree(
      { path: explicitPath, ref: "origin/main", steal_lock: true },
      "run-thief",
      { base_path: root, exec, lease: { acquire, release: vi.fn() }, contention_retry: { attempts: 3, sleep } },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("held by run:first");
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("fetches a bare commit SHA missing from the clone, then proceeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-sha-fetch-"));
    created.push(root);
    await mkdir(join(root, ".git"), { recursive: true });
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    let fetched = false;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "show-ref") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "remote") return { code: 0, stdout: "origin\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: fetched ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "fetch") {
        fetched = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree") {
        const worktreePath = args.at(-2);
        if (worktreePath) await mkdir(worktreePath, { recursive: true });
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await acquireWorktree(
      { branch: "caleb/pol-1826-review", ref: sha },
      "run-sha",
      { base_path: join(root, "worktrees"), exec },
    );

    expect(result.acquired).toBe(true);
    expect(exec).toHaveBeenCalledWith("git", ["fetch", "origin", sha], undefined);
  });

  test("surfaces remediation when a bare commit SHA cannot be fetched from any remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-sha-fail-"));
    created.push(root);
    await mkdir(join(root, ".git"), { recursive: true });
    const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "show-ref") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "remote") return { code: 0, stdout: "origin\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "fetch") return { code: 128, stdout: "", stderr: "remote rejected" };
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await acquireWorktree(
      { branch: "caleb/pol-1826-review", ref: sha },
      "run-sha-fail",
      { base_path: join(root, "worktrees"), exec },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("direct fetch from configured remotes did not recover it");
    expect(result.error).toContain("Push the commit to a configured remote");
  });

  test("creates an exact explicit path in create mode from the resolved repo clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-create-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    const targetPath = join(root, "custom", "calyx-pol-1156");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    const exec = mockGitWorktreeAdd();

    const result = await acquireWorktree(
      {
        mode: "create",
        repo: "calyx",
        path: targetPath,
        branch: "caleb/pol-1156-create-worktree-mode",
        ref: "origin/main",
      },
      "run-create-path",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(true);
    expect(result.path).toBe(targetPath);
    expect(exec).toHaveBeenCalledWith("git", [
      "worktree",
      "add",
      "-b",
      "caleb/pol-1156-create-worktree-mode",
      targetPath,
      "origin/main",
    ], { cwd: repoPath });
  });

  test("managed mode acquisition without a branch fails before any git mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-no-branch-managed-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

    const result = await acquireWorktree(
      { mode: "managed", repo: "calyx", ref: "origin/main" },
      "run-managed-no-branch",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain('Worktree mode "managed" requires --worktree-branch');
    expect(result.error).toContain("calyx-run/<lowercase issue>");
    expect(exec).not.toHaveBeenCalled();
  });

  test("create mode acquisition without a branch fails before any git mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-no-branch-create-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

    const result = await acquireWorktree(
      {
        mode: "create",
        repo: "calyx",
        path: join(root, "custom", "calyx-pol-1156"),
        ref: "origin/main",
      },
      "run-create-no-branch",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain('Worktree mode "create" requires --worktree-branch');
    expect(exec).not.toHaveBeenCalled();
  });

  test("repo resolver failures stop before git worktree commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-invalid-repo-root-"));
    created.push(root);
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

    const result = await acquireWorktree(
      {
        mode: "create",
        repo: "linnaeus",
        path: join(root, "wt", "pol-1385"),
        branch: "calyx-run/pol-1385",
        ref: "origin/main",
      },
      "run-invalid-repo-root",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => {
          throw new Error(
            [
              "Repo registry/config failure before worktree acquisition.",
              "host: carbon",
              "repo: linnaeus",
              `configured_root: ${join(root, "dev", "linnaeus", "dev")}`,
            ].join("\n"),
          );
        },
        exec,
      },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("Repo registry/config failure before worktree acquisition");
    expect(result.error).toContain("host: carbon");
    expect(result.error).toContain("repo: linnaeus");
    expect(result.error).toContain("configured_root:");
    expect(exec).not.toHaveBeenCalled();
  });

  test("adopts an existing Calyx-owned implementation branch without resetting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-existing-branch-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    await mkdir(join(repoPath, ".git"), { recursive: true });

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref" && args.includes("refs/heads/calyx-run/pol-1325")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          const target = args.at(-2);
          if (target) {
            await mkdir(target, { recursive: true });
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-run/pol-1325",
        ref: "origin/main",
      },
      "run-existing-branch",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(true);
    expect(result.path).toBe(join(root, "dev", "calyx", "wt", "calyx-run/pol-1325"));

    const showRefCall = exec.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === "show-ref");
    expect(showRefCall).toBeDefined();

    const worktreeAddCall = exec.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === "worktree" && args[1] === "add");
    expect(worktreeAddCall).toBeDefined();
    expect(worktreeAddCall![1]).toEqual([
      "worktree",
      "add",
      join(root, "dev", "calyx", "wt", "calyx-run/pol-1325"),
      "calyx-run/pol-1325",
    ]);
    expect(worktreeAddCall![1]).not.toContain("-b");
    const fetchCall = exec.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === "fetch");
    expect(fetchCall).toBeUndefined();
    const resetCall = exec.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === "reset");
    expect(resetCall).toBeUndefined();
  });

  test("resets a reused managed review worktree branch to the requested ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-existing-path-reset-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    const wtPath = join(root, "dev", "calyx", "wt", "calyx-review/pr-242-adversarial");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    await mkdir(wtPath, { recursive: true });

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref" && args.includes("refs/heads/calyx-review/pr-242-adversarial")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "remote") {
          return { code: 0, stdout: "origin\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { code: 0, stdout: "806cab6749819a2733a21ef507d8c9d5804829b5\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          return { code: 128, stdout: "", stderr: `fatal: '${wtPath}' already exists` };
        }
        if (cmd === "git" && args[0] === "status") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "reset") {
          return { code: 0, stdout: "HEAD is now at 806cab6 fix\n", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-review/pr-242-adversarial",
        ref: "806cab6749819a2733a21ef507d8c9d5804829b5",
        reset_on_reuse: true,
      },
      "run-existing-review-path",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(true);
    expect(exec).toHaveBeenCalledWith("git", ["reset", "--hard", "806cab6749819a2733a21ef507d8c9d5804829b5"], {
      cwd: wtPath,
    });
  });

  test("refuses reset_on_reuse for non-review branches", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-existing-non-review-reset-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    const wtPath = join(root, "dev", "calyx", "wt", "calyx-run/pol-1848");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    await mkdir(wtPath, { recursive: true });

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref" && args.includes("refs/heads/calyx-run/pol-1848")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "remote") {
          return { code: 0, stdout: "origin\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { code: 0, stdout: "806cab6749819a2733a21ef507d8c9d5804829b5\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          return { code: 128, stdout: "", stderr: `fatal: '${wtPath}' already exists` };
        }
        if (cmd === "git" && args[0] === "reset") {
          throw new Error("non-review branch must not be reset");
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-run/pol-1848",
        ref: "806cab6749819a2733a21ef507d8c9d5804829b5",
        reset_on_reuse: true,
      },
      "run-non-review-reset",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain('Refusing reset_on_reuse for non-review branch "calyx-run/pol-1848"');
  });

  test("refuses reset_on_reuse for review branches with tracked local changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-existing-review-dirty-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    const wtPath = join(root, "dev", "calyx", "wt", "calyx-review/pr-242-adversarial");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    await mkdir(wtPath, { recursive: true });

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref" && args.includes("refs/heads/calyx-review/pr-242-adversarial")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "remote") {
          return { code: 0, stdout: "origin\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "fetch") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { code: 0, stdout: "806cab6749819a2733a21ef507d8c9d5804829b5\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          return { code: 128, stdout: "", stderr: `fatal: '${wtPath}' already exists` };
        }
        if (cmd === "git" && args[0] === "status") {
          return { code: 0, stdout: " M packages/runner/src/worktree.ts\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "reset") {
          throw new Error("dirty review branch must not be reset");
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-review/pr-242-adversarial",
        ref: "806cab6749819a2733a21ef507d8c9d5804829b5",
        reset_on_reuse: true,
      },
      "run-dirty-review-reset",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("tracked local changes are present");
  });

  test("does not reset a reused branch based on branch-name convention alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-existing-path-no-reset-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    const wtPath = join(root, "dev", "calyx", "wt", "calyx-review/manual-implementation");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    await mkdir(wtPath, { recursive: true });

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref" && args.includes("refs/heads/calyx-review/manual-implementation")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "remote") {
          return { code: 0, stdout: "origin\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { code: 0, stdout: "806cab6749819a2733a21ef507d8c9d5804829b5\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          return { code: 128, stdout: "", stderr: `fatal: '${wtPath}' already exists` };
        }
        if (cmd === "git" && args[0] === "reset") {
          throw new Error("reset should be gated by reset_on_reuse, not branch prefix");
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-review/manual-implementation",
        ref: "806cab6749819a2733a21ef507d8c9d5804829b5",
      },
      "run-existing-review-like-path",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(true);
    expect(exec.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === "reset")).toBe(false);
  });

  test("managed mode fetches a stale remote-tracking ref before git worktree add", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-stale-remote-ref-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    const requestedRef = "origin/caleb/pol-1405-calyx-run-host-aware-short-run-handles-and-conductor-pickup";
    const requestedBranch = "caleb/pol-1405-calyx-run-host-aware-short-run-handles-and-conductor-pickup";
    let fetched = false;

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { code: fetched ? 0 : 1, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "remote") {
          return { code: 0, stdout: "origin\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "fetch") {
          fetched = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          const target = args.at(-2);
          if (target) {
            await mkdir(target, { recursive: true });
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-run/pol-1408",
        ref: requestedRef,
      },
      "run-stale-remote-ref",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(true);

    const fetchCallIndex = exec.mock.calls.findIndex(([, args]) => Array.isArray(args) && args[0] === "fetch");
    const worktreeAddCallIndex = exec.mock.calls.findIndex(([, args]) => Array.isArray(args) && args[0] === "worktree" && args[1] === "add");
    expect(fetchCallIndex).toBeGreaterThan(-1);
    expect(worktreeAddCallIndex).toBeGreaterThan(fetchCallIndex);
    expect(exec.mock.calls[fetchCallIndex]?.[1]).toEqual([
      "fetch",
      "origin",
      `+refs/heads/${requestedBranch}:refs/remotes/origin/${requestedBranch}`,
    ]);
    expect(exec.mock.calls[worktreeAddCallIndex]?.[1]).toContain(requestedRef);
  });

  test("managed mode retries origin/main refresh from the source clone before branching", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-refresh-main-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    let fetchAttempts = 0;
    const sleep = vi.fn(async () => {});

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "remote") {
          return { code: 0, stdout: "origin\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "fetch") {
          fetchAttempts += 1;
          return fetchAttempts < 3
            ? { code: 128, stdout: "", stderr: "fatal: transient fetch failure" }
            : { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { code: 0, stdout: "fresh-main\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          const target = args.at(-2);
          if (target) {
            await mkdir(target, { recursive: true });
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-run/pol-1848",
        ref: "origin/main",
      },
      "run-refresh-main",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
        contention_retry: { attempts: 3, sleep },
      },
    );

    expect(result.acquired).toBe(true);
    expect(fetchAttempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith("git", [
      "fetch",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ], { cwd: repoPath });
    const fetchCallIndex = exec.mock.calls.findIndex(([, args]) => Array.isArray(args) && args[0] === "fetch");
    const worktreeAddCallIndex = exec.mock.calls.findIndex(([, args]) => Array.isArray(args) && args[0] === "worktree" && args[1] === "add");
    expect(worktreeAddCallIndex).toBeGreaterThan(fetchCallIndex);
  });

  test("managed mode refuses before branching when origin/main cannot refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-refresh-main-fail-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    const localHead = "1111111111111111111111111111111111111111";
    const remoteHead = "2222222222222222222222222222222222222222";
    const sleep = vi.fn(async () => {});

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "remote") {
          return { code: 0, stdout: "origin\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "ls-remote") {
          return { code: 0, stdout: `${remoteHead}\trefs/heads/main\n`, stderr: "" };
        }
        if (cmd === "git" && args[0] === "fetch") {
          return { code: 128, stdout: "", stderr: "fatal: fetch failed" };
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { code: 0, stdout: `${localHead}\n`, stderr: "" };
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-run/pol-1848",
        ref: "origin/main",
      },
      "run-refresh-main-fail",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
        contention_retry: { attempts: 2, sleep },
      },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain('Worktree ref "origin/main" could not be refreshed from remote "origin" before git worktree add.');
    expect(result.error).toContain("failed after 2 attempt(s)");
    expect(result.error).toContain("fatal: fetch failed");
    expect(result.error).toContain(`Remote advertised ${remoteHead}, but local origin/main resolves to ${localHead}.`);
    expect(sleep).toHaveBeenCalledTimes(1);
    const worktreeAddCall = exec.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === "worktree" && args[1] === "add");
    expect(worktreeAddCall).toBeUndefined();
  });

  test("managed mode continues when fetch fails but origin/main is verified current", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-refresh-main-current-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    const currentHead = "1234567890abcdef1234567890abcdef12345678";

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "remote") {
          return { code: 0, stdout: "origin\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "ls-remote") {
          return { code: 0, stdout: `${currentHead}\trefs/heads/main\n`, stderr: "" };
        }
        if (cmd === "git" && args[0] === "fetch") {
          return { code: 128, stdout: "", stderr: "fatal: fetch failed" };
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { code: 0, stdout: `${currentHead}\n`, stderr: "" };
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          const target = args.at(-2);
          if (target) {
            await mkdir(target, { recursive: true });
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-run/pol-1848",
        ref: "origin/main",
      },
      "run-refresh-main-current",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
        contention_retry: { attempts: 2, sleep: async () => {} },
      },
    );

    expect(result.acquired).toBe(true);
    expect(exec).toHaveBeenCalledWith("git", ["ls-remote", "origin", "refs/heads/main"], { cwd: repoPath });
    expect(exec).toHaveBeenCalledWith("git", [
      "fetch",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ], { cwd: repoPath });
    const worktreeAddCall = exec.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === "worktree" && args[1] === "add");
    expect(worktreeAddCall).toBeDefined();
  });

  test("managed mode refuses an ambiguous remote-tracking ref before git worktree add", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-ambiguous-remote-ref-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    await mkdir(join(repoPath, ".git"), { recursive: true });

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "remote") {
          return { code: 0, stdout: "origin\norigin/main\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "fetch") {
          throw new Error("ambiguous remote ref must fail before fetch");
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          throw new Error("ambiguous remote ref must fail before worktree add");
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-run/pol-1848",
        ref: "origin/main/foo",
      },
      "run-ambiguous-remote-ref",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
      },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain('Worktree ref "origin/main/foo" is ambiguous across configured remotes (origin, origin/main)');
  });

  test("managed mode reports an unresolved remote ref before git worktree add", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-missing-remote-ref-"));
    created.push(root);
    const repoPath = join(root, "dev", "calyx", "dev");
    await mkdir(join(repoPath, ".git"), { recursive: true });

    const exec = vi.fn(
      async (cmd: string, args: string[], _options?: { cwd?: string }) => {
        if (cmd === "git" && args[0] === "show-ref") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (cmd === "git" && args[0] === "remote") {
          return { code: 0, stdout: "origin\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "fetch") {
          return { code: 128, stdout: "", stderr: "fatal: couldn't find remote ref refs/heads/missing-pol-1408" };
        }
        if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
          return { code: 128, stdout: "", stderr: "fatal: invalid reference: origin/missing-pol-1408" };
        }
        return { code: 1, stdout: "", stderr: "unexpected exec" };
      },
    );

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        branch: "calyx-run/pol-1408",
        ref: "origin/missing-pol-1408",
      },
      "run-missing-remote-ref",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => repoPath,
        exec,
        contention_retry: { attempts: 1 },
      },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain('Worktree ref "origin/missing-pol-1408" could not be refreshed from remote "origin" before git worktree add.');
    expect(result.error).toContain("fatal: couldn't find remote ref refs/heads/missing-pol-1408");
    const worktreeAddCall = exec.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === "worktree" && args[1] === "add");
    expect(worktreeAddCall).toBeUndefined();
  });

  test("managed mode rejects explicit worktree paths at the runner level", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-worktree-managed-path-"));
    created.push(root);
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

    const result = await acquireWorktree(
      {
        mode: "managed",
        repo: "calyx",
        path: join(root, "should-not-be-used"),
        branch: "caleb/pol-1156-create-worktree-mode",
      },
      "run-managed-path",
      {
        base_path: join(root, "projects"),
        resolve_repo: async () => join(root, "dev", "calyx", "dev"),
        exec,
      },
    );

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("Managed worktree mode does not accept an explicit worktree path");
    expect(exec).not.toHaveBeenCalled();
  });
});

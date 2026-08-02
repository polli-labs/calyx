import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  DaemonDescriptor,
  DaemonEvent,
  DaemonRecord,
  DaemonStateSnapshot,
  IssueRuntimeRecord,
  WorkflowFile,
} from "./types.js";

export interface DaemonPaths {
  daemonDir: string;
  descriptorPath: string;
  daemonRecordPath: string;
  workflowSnapshotPath: string;
  stateSnapshotPath: string;
  issuesDir: string;
  eventsPath: string;
  pidPath: string;
}

export function defaultDaemonsRoot(): string {
  const fromEnv = process.env["CALYX_DAEMONS_ROOT"];
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }
  return path.join(homedir(), ".calyx", "daemons");
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeTextFileAtomic(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, filePath);
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export class DaemonStore {
  readonly root: string;

  constructor(root = defaultDaemonsRoot()) {
    this.root = path.resolve(root);
  }

  paths(daemonId: string): DaemonPaths {
    const daemonDir = path.join(this.root, daemonId);
    return {
      daemonDir,
      descriptorPath: path.join(daemonDir, "daemon.json"),
      daemonRecordPath: path.join(daemonDir, "daemon_record.json"),
      workflowSnapshotPath: path.join(daemonDir, "workflow.snapshot.json"),
      stateSnapshotPath: path.join(daemonDir, "state.snapshot.json"),
      issuesDir: path.join(daemonDir, "issues"),
      eventsPath: path.join(daemonDir, "events.jsonl"),
      pidPath: path.join(daemonDir, "pid"),
    };
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async ensureDaemonRoot(daemonId: string): Promise<void> {
    const paths = this.paths(daemonId);
    await mkdir(paths.daemonDir, { recursive: true });
    await mkdir(paths.issuesDir, { recursive: true });
  }

  async writeDescriptor(daemonId: string, descriptor: DaemonDescriptor): Promise<void> {
    await writeJsonFile(this.paths(daemonId).descriptorPath, descriptor);
  }

  async readDescriptor(daemonId: string): Promise<DaemonDescriptor | undefined> {
    return readJsonFile<DaemonDescriptor>(this.paths(daemonId).descriptorPath);
  }

  async writeDaemonRecord(daemonId: string, record: DaemonRecord): Promise<void> {
    await writeJsonFile(this.paths(daemonId).daemonRecordPath, record);
  }

  async readDaemonRecord(daemonId: string): Promise<DaemonRecord | undefined> {
    return readJsonFile<DaemonRecord>(this.paths(daemonId).daemonRecordPath);
  }

  async writeWorkflowSnapshot(daemonId: string, workflow: WorkflowFile): Promise<void> {
    await writeJsonFile(this.paths(daemonId).workflowSnapshotPath, workflow);
  }

  async readWorkflowSnapshot(daemonId: string): Promise<WorkflowFile | undefined> {
    return readJsonFile<WorkflowFile>(this.paths(daemonId).workflowSnapshotPath);
  }

  async writeIssueRecord(daemonId: string, issue: IssueRuntimeRecord): Promise<void> {
    const target = path.join(this.paths(daemonId).issuesDir, `${issue.issue_identifier}.json`);
    await writeJsonFile(target, issue);
  }

  async writeStateSnapshot(daemonId: string, state: DaemonStateSnapshot): Promise<void> {
    await writeJsonFile(this.paths(daemonId).stateSnapshotPath, state);
    await this.ensureDaemonRoot(daemonId);
    const currentFiles = new Set((await readdir(this.paths(daemonId).issuesDir)).filter((entry) => entry.endsWith(".json")));
    for (const issue of Object.values(state.issues)) {
      await this.writeIssueRecord(daemonId, issue);
      currentFiles.delete(`${issue.issue_identifier}.json`);
    }
    for (const leftover of currentFiles) {
      await rm(path.join(this.paths(daemonId).issuesDir, leftover), { force: true });
    }
  }

  async readStateSnapshot(daemonId: string): Promise<DaemonStateSnapshot | undefined> {
    return readJsonFile<DaemonStateSnapshot>(this.paths(daemonId).stateSnapshotPath);
  }

  async appendEvent(daemonId: string, event: DaemonEvent): Promise<void> {
    const paths = this.paths(daemonId);
    await this.ensureDaemonRoot(daemonId);
    await writeFile(paths.eventsPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }

  async readEvents(daemonId: string): Promise<DaemonEvent[]> {
    const text = await readTextFile(this.paths(daemonId).eventsPath);
    if (!text) {
      return [];
    }
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as DaemonEvent);
  }

  async writePid(daemonId: string, pid: number): Promise<void> {
    await this.ensureDaemonRoot(daemonId);
    await writeTextFileAtomic(this.paths(daemonId).pidPath, `${pid}\n`);
  }

  async readPid(daemonId: string): Promise<number | undefined> {
    const text = await readTextFile(this.paths(daemonId).pidPath);
    if (!text) {
      return undefined;
    }
    const parsed = Number.parseInt(text.trim(), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  async clearPid(daemonId: string): Promise<void> {
    await rm(this.paths(daemonId).pidPath, { force: true });
  }
}

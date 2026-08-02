import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  LatestSessionInfo,
  SessionDiscoveryFs,
  SessionInfo,
} from "@polli-labs/calyx-runner";

const defaultFs: SessionDiscoveryFs = {
  readdir: async (p) => {
    const entries = await readdir(p);
    return entries;
  },
  readFile: async () => {
    throw new Error("Codex session discovery does not read file contents.");
  },
  stat: async () => {
    throw new Error("Codex session discovery does not use stat().");
  },
  homedir,
};

export async function discoverCodexSession(
  startTime: number,
  endTime: number,
  fs: SessionDiscoveryFs = defaultFs,
): Promise<SessionInfo | undefined> {
  try {
    const home = fs.homedir();
    const dateDirs = getCodexDateDirs(startTime, endTime);
    const sessionsBase = join(home, ".codex", "sessions");

    let bestMatch: { uuid: string; path: string; timestamp: number } | undefined;

    for (const dateDir of dateDirs) {
      const dirPath = join(sessionsBase, dateDir);
      let entries: string[];
      try {
        entries = await fs.readdir(dirPath);
      } catch {
        continue;
      }

      const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
      for (const file of jsonlFiles) {
        const parsed = parseCodexFilename(file);
        if (!parsed) continue;
        if (parsed.timestamp < startTime || parsed.timestamp > endTime) continue;

        if (!bestMatch || parsed.timestamp > bestMatch.timestamp) {
          bestMatch = {
            uuid: parsed.uuid,
            path: join(dirPath, file),
            timestamp: parsed.timestamp,
          };
        }
      }
    }

    if (!bestMatch) return undefined;

    return {
      id: bestMatch.uuid,
      path: bestMatch.path,
      backend: "codex",
    };
  } catch {
    return undefined;
  }
}

export async function findLatestCodexSession(
  fs: SessionDiscoveryFs = defaultFs,
): Promise<LatestSessionInfo | undefined> {
  try {
    const home = fs.homedir();
    const sessionsBase = join(home, ".codex", "sessions");

    let yearDirs: string[];
    try {
      yearDirs = await fs.readdir(sessionsBase);
    } catch {
      return undefined;
    }

    yearDirs.sort((a, b) => b.localeCompare(a));

    let best: { uuid: string; path: string; timestamp: number } | undefined;

    for (const year of yearDirs) {
      if (!/^\d{4}$/.test(year)) continue;

      let monthDirs: string[];
      try {
        monthDirs = await fs.readdir(join(sessionsBase, year));
      } catch {
        continue;
      }
      monthDirs.sort((a, b) => b.localeCompare(a));

      for (const month of monthDirs) {
        if (!/^\d{2}$/.test(month)) continue;

        let dayDirs: string[];
        try {
          dayDirs = await fs.readdir(join(sessionsBase, year, month));
        } catch {
          continue;
        }
        dayDirs.sort((a, b) => b.localeCompare(a));

        for (const day of dayDirs) {
          if (!/^\d{2}$/.test(day)) continue;

          const dirPath = join(sessionsBase, year, month, day);
          let entries: string[];
          try {
            entries = await fs.readdir(dirPath);
          } catch {
            continue;
          }

          const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
          for (const file of jsonlFiles) {
            const parsed = parseCodexFilename(file);
            if (!parsed) continue;

            if (!best || parsed.timestamp > best.timestamp) {
              best = {
                uuid: parsed.uuid,
                path: join(dirPath, file),
                timestamp: parsed.timestamp,
              };
            }
          }
        }
      }
    }

    if (!best) return undefined;

    return {
      id: best.uuid,
      path: best.path,
      backend: "codex",
      startedAt: best.timestamp,
    };
  } catch {
    return undefined;
  }
}

function parseCodexFilename(
  filename: string,
): { timestamp: number; uuid: string } | undefined {
  const match = filename.match(/^rollout-(\d+)-([0-9a-f-]+)\.jsonl$/);
  if (match && match[1] && match[2]) {
    const ts = Number.parseInt(match[1], 10);
    if (!Number.isNaN(ts)) {
      return { timestamp: ts, uuid: match[2] };
    }
  }
  return undefined;
}

function getCodexDateDirs(startTime: number, endTime: number): string[] {
  const dirs: string[] = [];
  const startDate = new Date(startTime);
  const endDate = new Date(endTime);

  const current = new Date(startDate);
  current.setUTCHours(0, 0, 0, 0);

  const lastDay = new Date(endDate);
  lastDay.setUTCHours(23, 59, 59, 999);

  while (current <= lastDay) {
    const yyyy = current.getUTCFullYear().toString();
    const mm = (current.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = current.getUTCDate().toString().padStart(2, "0");
    dirs.push(join(yyyy, mm, dd));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dirs;
}

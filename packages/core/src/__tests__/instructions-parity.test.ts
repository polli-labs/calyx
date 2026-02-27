import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, test } from "vitest";
import { renderInstructionsFromFiles } from "../instructions";

type Scalar = string | number | boolean;

type Context = Record<string, Scalar>;

function legacyReplaceAll(source: string, replacements: Context): string {
  return Object.entries(replacements).reduce((acc, [key, value]) => acc.split(`{{${key}}}`).join(String(value)), source);
}

function legacyExpandPartials(source: string, partialsDir: string, depth = 0): string {
  if (depth > 5) {
    return source;
  }

  const includePattern = /\{\{>\s*([^}\s]+)\s*\}\}/g;
  return source.replace(includePattern, (_match, partialName: string) => {
    const partialPath = path.join(partialsDir, `${partialName}.md.mustache`);
    let partialSource = `<!-- Missing partial: ${partialName} -->`;
    try {
      partialSource = readFileSync(partialPath, "utf8");
    } catch {
      return partialSource;
    }
    return legacyExpandPartials(partialSource, partialsDir, depth + 1);
  });
}

function buildContextForLegacy(
  fleetInput: { instructions?: { context?: Record<string, unknown> } },
  hostInput: { user?: unknown; home?: unknown; instructions?: { context?: Record<string, unknown> } },
  hostAlias: string
): Context {
  const context: Context = {};

  const fleetContext = fleetInput.instructions?.context ?? {};
  for (const [key, value] of Object.entries(fleetContext)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      context[key] = value;
    }
  }

  const hostContext = hostInput.instructions?.context ?? {};
  for (const [key, value] of Object.entries(hostContext)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      context[key] = value;
    }
  }

  context.HOST = hostAlias;
  context.HOSTNAME = hostAlias;
  context.HOST_ALIAS = hostAlias;
  if (typeof hostInput.user === "string") {
    context.USER = hostInput.user;
  }
  if (typeof hostInput.home === "string") {
    context.HOME = hostInput.home;
  }

  return context;
}

describe("instructions parity against legacy Polli renderer semantics", () => {
  test.each(["blade", "worm"])("legacy parity for %s", async (host) => {
    const root = path.resolve(process.cwd(), "fixtures/instructions");
    const fleetPath = path.join(root, "inputs/fleet.v1.yaml");
    const hostPath = path.join(root, `inputs/hosts/${host}.yaml`);
    const templatePath = path.join(root, "templates/AGENTS.sample.md.mustache");
    const partialsDir = path.join(root, "templates/partials");

    const fleetInput = YAML.parse(readFileSync(fleetPath, "utf8")) as {
      instructions?: { context?: Record<string, unknown> };
    };
    const hostInput = YAML.parse(readFileSync(hostPath, "utf8")) as {
      user?: unknown;
      home?: unknown;
      instructions?: { context?: Record<string, unknown> };
    };

    const legacyContext = buildContextForLegacy(fleetInput, hostInput, host);
    const templateSource = readFileSync(templatePath, "utf8");
    const legacyOutput = legacyReplaceAll(legacyExpandPartials(templateSource, partialsDir), legacyContext);

    const current = await renderInstructionsFromFiles(
      {
        fleetPath,
        hostsDir: path.join(root, "inputs/hosts"),
        templatePath,
        partialsDir
      },
      { host }
    );

    expect(current.results).toHaveLength(1);
    const firstResult = current.results[0];
    expect(firstResult).toBeDefined();
    if (!firstResult) {
      return;
    }
    expect(firstResult.output).toBe(legacyOutput);
  });
});

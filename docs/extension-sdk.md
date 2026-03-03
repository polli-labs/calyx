# Calyx Extension SDK

The `@polli-labs/calyx-sdk` package provides contracts and helpers for building Calyx extensions. Extensions hook into the Calyx CLI to add custom behavior around domain commands.

## Concepts

### Package boundaries

Calyx ships as four npm packages:

| Package | Purpose |
|---------|---------|
| `@polli-labs/calyx` | CLI binary (`calyx` command) |
| `@polli-labs/calyx-core` | Domain contracts, compilers, validators |
| `@polli-labs/calyx-sdk` | Extension SDK (this package) |
| `@polli-labs/calyx-web` | Web companion surface |

Extensions depend on `@polli-labs/calyx-sdk` as a peer dependency. They do **not** need to depend on `calyx-core` or the CLI directly.

### Domains

Calyx is organized into 8 domains:

| Domain | Description |
|--------|-------------|
| `config` | Fleet/host YAML compilation to Codex TOML |
| `instructions` | Template rendering with token and partial expansion |
| `skills` | Skills registry management |
| `tools` | Tools registry management |
| `prompts` | Prompts registry management |
| `agents` | Agents registry, profiles, deployment |
| `knowledge` | Knowledge artifact indexing, search, linking |
| `exec` | Execution lifecycle (launch, status, logs, receipt) |

Extensions declare which domains they target in their manifest.

### Naming convention

Extensions follow the naming convention from [ADR-0002](./adr/adr-0002-repo-structure-and-build.md):

| Scope | Pattern | Examples |
|-------|---------|----------|
| First-party | `calyx-ext-<name>` | `calyx-ext-polli`, `calyx-ext-linear` |
| Harness-target | `calyx-ext-<harness>` | `calyx-ext-cursor`, `calyx-ext-aider` |
| Community (scoped) | `@user/calyx-ext-<name>` | `@acme/calyx-ext-deploy` |

## Quick start

### 1. Create a package

```bash
mkdir calyx-ext-hello && cd calyx-ext-hello
npm init -y
npm install --save-dev @polli-labs/calyx-sdk typescript
```

### 2. Declare the manifest in `package.json`

```json
{
  "name": "calyx-ext-hello",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "calyx": {
    "apiVersion": "1",
    "domains": ["skills"]
  },
  "peerDependencies": {
    "@polli-labs/calyx-sdk": ">=0.1.0"
  }
}
```

### 3. Implement the extension

```typescript
// src/index.ts
import type { CalyxExtension } from "@polli-labs/calyx-sdk";

const extension: CalyxExtension = {
  manifest: {
    name: "calyx-ext-hello",
    version: "1.0.0",
    calyx: { apiVersion: "1", domains: ["skills"] },
  },
  hooks: {
    async activate(ctx) {
      console.log(`[hello] activated in ${ctx.workspaceRoot}`);
      return { ok: true };
    },
    async beforeCommand(ctx, domain, command) {
      console.log(`[hello] before ${domain} ${command}`);
      return { ok: true };
    },
    async afterCommand(ctx, domain, command, exitCode) {
      console.log(`[hello] after ${domain} ${command} (exit ${exitCode})`);
      return { ok: true };
    },
  },
};

export default extension;
```

### 4. Validate the manifest

```typescript
import { validateManifest } from "@polli-labs/calyx-sdk";
import pkg from "./package.json" with { type: "json" };

const result = validateManifest(pkg);
if (!result.ok) {
  for (const issue of result.issues) {
    console.error(`[${issue.code}] ${issue.message}`);
  }
  process.exit(1);
}
```

## API Reference

### Types

#### `CalyxDomain`

Union of the 8 supported domain strings:

```typescript
type CalyxDomain =
  | "config" | "instructions" | "skills" | "tools"
  | "prompts" | "agents" | "knowledge" | "exec";
```

#### `CalyxExtensionManifest`

```typescript
interface CalyxExtensionManifest {
  name: string;
  version: string;
  calyx: {
    apiVersion: string;
    domains: CalyxDomain[];
  };
}
```

#### `ExtensionContext`

Passed to all lifecycle hooks:

```typescript
interface ExtensionContext {
  workspaceRoot: string;
  calyxVersion: string;
  manifest: CalyxExtensionManifest;
}
```

#### `HookResult`

Returned from all lifecycle hooks:

```typescript
interface HookResult {
  ok: boolean;
  messages?: string[];
}
```

#### `CalyxExtensionHooks`

All hooks are optional:

```typescript
interface CalyxExtensionHooks {
  activate?(ctx: ExtensionContext): Promise<HookResult>;
  beforeCommand?(ctx: ExtensionContext, domain: CalyxDomain, command: string): Promise<HookResult>;
  afterCommand?(ctx: ExtensionContext, domain: CalyxDomain, command: string, exitCode: number): Promise<HookResult>;
  deactivate?(ctx: ExtensionContext): Promise<HookResult>;
}
```

#### `CalyxExtension`

Top-level extension definition (the default export of your extension):

```typescript
interface CalyxExtension {
  manifest: CalyxExtensionManifest;
  hooks?: CalyxExtensionHooks;
}
```

### Functions

#### `validateManifest(manifest: unknown): ManifestValidationResult`

Validates an extension manifest object. Returns `{ ok, issues }` where each issue has a `code` and `message`.

Error codes:
- `MANIFEST_NOT_OBJECT` — Input is not an object
- `MISSING_NAME` — Missing or empty `name`
- `MISSING_VERSION` — Missing or empty `version`
- `MISSING_CALYX` — Missing `calyx` object
- `MISSING_API_VERSION` — Missing or empty `calyx.apiVersion`
- `MISSING_DOMAINS` — Missing or empty `calyx.domains` array
- `INVALID_DOMAIN` — Unknown domain string in `calyx.domains`

### Constants

#### `CALYX_DOMAINS`

Readonly array of all supported domain strings.

#### `CALYX_SDK_API_VERSION`

Current SDK API version string (`"1"`). Extensions should set `calyx.apiVersion` to this value.

## Lifecycle

Extensions go through this lifecycle:

```
load → activate → (beforeCommand → command → afterCommand)* → deactivate
```

1. **Load**: Calyx reads the extension's `package.json` manifest and resolves the main module.
2. **Activate**: The `activate` hook runs once. Use it for one-time setup or environment validation.
3. **Before/After command**: These hooks bracket every domain command invocation. `beforeCommand` can abort execution by returning `{ ok: false }`.
4. **Deactivate**: Runs on CLI exit. Use it for cleanup.

The CLI automatically wires extension hooks into all domain commands (`skills`, `tools`, `prompts`, `agents`, `knowledge`, `exec`). When `CALYX_EXTENSIONS_PATH` is set, extensions are discovered, loaded, and activated on the first domain command. Hooks run via commander `preAction`/`postAction` hooks on each domain's parent command.

## Extension Loader & Runtime

### Discovery

Extensions are discovered from configured search paths. Each search path is scanned for immediate subdirectories containing a `package.json` with a `calyx` key. Configure search paths via:

- `--search-path` CLI flag
- `CALYX_EXTENSIONS_PATH` environment variable (colon-separated paths)

Discovery is **deterministic**: directories are sorted alphabetically, and later search paths shadow earlier ones (last-write-wins by extension name).

### Loading

Each discovered extension goes through these validation steps:

1. **Manifest validation** — `package.json` must pass `validateManifest()` checks.
2. **API version compatibility** — `calyx.apiVersion` must match the current SDK version (`"1"`).
3. **Module import** — The `main` entry point is dynamically imported.
4. **Export validation** — The default export must be a valid `CalyxExtension` object.

If any step fails, the extension is skipped with operator-readable diagnostics.

### Conflict Detection

When multiple extensions claim the same domain, a **domain conflict** is reported. In strict mode, conflicts are errors; in advisory mode, they are warnings.

### CLI Commands

```bash
# List discovered extensions
calyx extensions list --search-path ./extensions

# Validate all extensions (manifests, compatibility, conflicts)
calyx extensions validate --search-path ./extensions --strict

# Check a single extension package
calyx extensions check --path ./my-extension
```

### Diagnostics

The loader produces structured diagnostics with these codes:

| Code | Meaning |
|------|---------|
| `MANIFEST_READ_FAILED` | Cannot read `package.json` |
| `MANIFEST_PARSE_FAILED` | Invalid JSON in `package.json` |
| `MISSING_NAME` | Missing or empty `name` |
| `MISSING_VERSION` | Missing or empty `version` |
| `MISSING_CALYX` | Missing `calyx` object |
| `MISSING_API_VERSION` | Missing or empty `calyx.apiVersion` |
| `MISSING_DOMAINS` | Missing or empty `calyx.domains` array |
| `INVALID_DOMAIN` | Unknown domain in `calyx.domains` |
| `API_VERSION_MISMATCH` | Extension targets a different API version |
| `MODULE_IMPORT_FAILED` | Failed to dynamically import the extension |
| `INVALID_EXPORT` | Default export is not a valid `CalyxExtension` |
| `SEARCH_PATH_UNREADABLE` | Cannot read a search path directory |
| `EXTENSION_SHADOWED` | An extension was shadowed by a later search path |
| `DOMAIN_CONFLICT` | Multiple extensions claim the same domain |

### ExtensionRunner

The `ExtensionRunner` class manages the lifecycle of loaded extensions:

```typescript
import { ExtensionRunner } from "@polli-labs/calyx-core";

const runner = new ExtensionRunner(extensions, {
  workspaceRoot: "/path/to/workspace",
  calyxVersion: "0.1.1",
});

await runner.activate();
await runner.beforeCommand("skills", "sync");
// ... run the command ...
await runner.afterCommand("skills", "sync", 0);
await runner.deactivate();
```

Hooks run in deterministic order (alphabetical by extension name). A failing `beforeCommand` hook aborts the command; all other hook failures are collected as diagnostics.

## First-Party Extensions

### calyx-ext-polli

The `calyx-ext-polli` package is the first-party Polli extension. It provides:

- **Pre-flight checks** on `sync`, `deploy`, and `validate` commands
- **Environment readiness** diagnostics (checks for expected env vars)
- **Structured summaries** after command failures

Install: the extension ships in `packages/calyx-ext-polli` within the monorepo.

## Compatibility

- Extensions target a specific `apiVersion`. The current version is `"1"`.
- The SDK follows semver. Non-breaking additions (new optional hook parameters, new domains) are minor bumps.
- Breaking contract changes (removing hooks, changing required fields) are major bumps and will increment `apiVersion`.

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

Targets: `skills`, `tools`, `agents`. Ships in `packages/calyx-ext-polli` within the monorepo.

### calyx-ext-linear

The `calyx-ext-linear` package provides Linear issue-tracking context for agents and execution workflows. It provides:

- **Environment hints** for `LINEAR_API_KEY` and `LINEAR_TEAM` on activation
- **Issue context checks** before `launch`, `deploy`, `sync`, and `status` commands
- **Failure diagnostics** with Linear-friendly suggestions (structured receipts for issue comments)

Targets: `agents`, `exec`. Ships in `packages/calyx-ext-linear` within the monorepo. Non-destructive — never blocks commands.

### calyx-ext-cursor

The `calyx-ext-cursor` package is a harness-target extension for Cursor-based agent workflows. It provides:

- **Environment detection** for Cursor-specific indicators (`CURSOR_SESSION_ID`, `CURSOR_WORKSPACE`)
- **Command hints** for config, instructions, and skills commands with Cursor-specific guidance
- **Failure diagnostics** with Cursor-aware troubleshooting suggestions
- **Rules file awareness** for `.cursor/rules` and `.cursorrules` paths

Targets: `config`, `instructions`, `skills`. Ships in `packages/calyx-ext-cursor` within the monorepo. Non-destructive — never blocks commands.

## Starter Template

A copy-and-customize starter template is available at [`examples/extensions/starter/`](../examples/extensions/starter/). It includes:

- `package.json` with a complete `calyx` manifest block
- `src/index.ts` — annotated extension entrypoint with all 4 lifecycle hooks
- `src/validate.ts` — standalone manifest validation script
- `src/__tests__/extension.test.ts` — test scaffold with vitest
- `README.md` — quickstart for external authors

To use:

```bash
# Copy the starter
cp -r examples/extensions/starter calyx-ext-myname
cd calyx-ext-myname

# Update package.json: name, description, domains
# Implement your hooks in src/index.ts
# Validate
npx tsx src/validate.ts

# Build and test with Calyx
npm run build
CALYX_EXTENSIONS_PATH=$(dirname $(pwd)) calyx extensions list
```

## Compatibility Policy

### API Version Matrix

Extensions declare a `calyx.apiVersion` in their manifest. The loader enforces exact-match compatibility: an extension targeting apiVersion `"1"` will only load on SDK versions that report `CALYX_SDK_API_VERSION === "1"`.

| API Version | SDK Versions | Status | Notes |
|-------------|-------------|--------|-------|
| `"1"` | `>=0.1.0` | **Current** | Stable contract. All shipped extensions target this version. |

When a new API version is introduced, the previous version enters a **deprecation window** of at least one minor SDK release. During this window, the loader emits an `API_VERSION_DEPRECATED` warning (advisory) or error (strict mode). After the window closes, the old version produces `API_VERSION_MISMATCH` (always error).

### Semver Expectations

| Component | Versioning | Policy |
|-----------|-----------|--------|
| `@polli-labs/calyx-sdk` | Semver | Minor bumps for additive changes (new optional hook params, new domains). Major bumps for breaking changes; `apiVersion` increments. |
| Extension packages | Semver | Authors should follow semver. SDK peer dep should use range (e.g., `>=0.1.0`). |
| `calyx.apiVersion` | Integer string | Increments only on breaking SDK contract changes. Matches SDK major version where possible. |

### Extension Package Semver Guidance

- **Peer dependency range**: Use `"@polli-labs/calyx-sdk": ">=0.1.0"` (or the appropriate minimum for your target apiVersion). Avoid pinning to exact versions.
- **Extension version**: Follow semver for your own package. Bump major when changing hook behavior in breaking ways.
- **apiVersion in manifest**: Must exactly match the SDK's `CALYX_SDK_API_VERSION`. Do not use ranges.

### Migration Path

When `apiVersion` advances (e.g., `"1"` → `"2"`):

1. The new SDK release supports both old and new apiVersions during the deprecation window.
2. Extensions targeting the old version see `API_VERSION_DEPRECATED` diagnostics with migration guidance.
3. Authors update their `calyx.apiVersion` and adapt to any contract changes.
4. After the deprecation window, the old version is no longer supported (error on load).

### Unsupported / Deprecated Behavior

| Scenario | Diagnostic | Severity |
|----------|-----------|----------|
| Extension targets current apiVersion | None | — |
| Extension targets deprecated apiVersion (within window) | `API_VERSION_DEPRECATED` | warning (advisory) / error (strict) |
| Extension targets unsupported apiVersion | `API_VERSION_MISMATCH` | error (always) |
| Extension has no `calyx.apiVersion` | `MISSING_API_VERSION` | error (always) |

## Conflict Governance

### Domain Conflicts

A domain conflict occurs when multiple loaded extensions claim the same domain. The conflict governance mode determines how conflicts are handled:

| Mode | Behavior | How to set |
|------|----------|-----------|
| **Advisory** (default) | Conflicts are reported as warnings. All conflicting extensions load and hooks run in alphabetical order. | Default behavior |
| **Strict** | Conflicts are reported as errors. Extensions still load, but the error-severity diagnostic signals the operator to resolve the conflict before production use. | `--strict` flag or `strict: true` in discovery options |

### Advisory Mode

In advisory mode, domain conflicts produce `DOMAIN_CONFLICT` diagnostics with severity `warning`. All conflicting extensions remain loaded and their hooks execute in deterministic (alphabetical by name) order.

This is appropriate for development environments where multiple extensions may legitimately overlap (e.g., a first-party extension and a user's custom override).

### Strict Mode

In strict mode, domain conflicts produce `DOMAIN_CONFLICT` diagnostics with severity `error`. The operator should resolve the conflict by:

1. **Removing** one of the conflicting extensions from the search path.
2. **Reconfiguring** extension domains so they don't overlap.
3. **Using search path shadowing** — placing the preferred extension in a later search path so it shadows the other.

### Conflict Resolution Strategies

| Strategy | When to use |
|----------|------------|
| Remove conflicting extension | One extension is unnecessary |
| Narrow domain list | Extension doesn't need all claimed domains |
| Shadow via search path ordering | User extension should override a default |
| Accept advisory warnings | Development/testing environments |

### Deterministic Ordering

All hooks run in **alphabetical order by extension name**, regardless of discovery order or search path order. This ensures reproducible behavior across environments. The only exception is search path shadowing, where later paths replace earlier paths (by directory name, not extension name).

## Harness-Target Extensions

Harness-target extensions adapt Calyx for specific agent harnesses (e.g., Cursor, Aider, Windsurf). They follow the naming pattern `calyx-ext-<harness>` and provide:

- **Environment detection**: Check for harness-specific indicators on activation.
- **Command hints**: Advisory diagnostics before domain commands with harness-specific guidance.
- **Failure diagnostics**: Harness-aware troubleshooting suggestions after command failures.

Harness-target extensions must be **non-destructive**: they should never block commands (always return `ok: true`). Their purpose is to augment operator awareness, not to gate execution.

### Shipped Harness-Target Extensions

| Extension | Domains | Harness | Purpose |
|-----------|---------|---------|---------|
| `calyx-ext-cursor` | config, instructions, skills | Cursor | Environment hints, rules-format awareness, Cursor-specific troubleshooting |

### Building a Harness-Target Extension

Use the starter template or an existing harness-target extension as a reference:

```bash
# Copy from starter
cp -r examples/extensions/starter calyx-ext-myharness

# Or adapt the cursor extension
cp -r packages/calyx-ext-cursor calyx-ext-myharness
```

Key design principles:
1. **Non-destructive**: Always return `ok: true` from all hooks.
2. **Advisory diagnostics**: Use `messages` to surface hints, not to block.
3. **Environment detection**: Check for harness-specific env vars or config files on activate.
4. **Targeted domains**: Only claim domains where the harness has meaningful integration points.

# Getting Started with Calyx

Calyx is a unified, contract-first CLI for managing agent infrastructure — config compilation, instruction rendering, skill/tool/prompt registries, agent deployment, knowledge linking, and execution lifecycle. It replaces fragmented operational scripts with typed domain commands, consistent exit codes, and machine-readable output.

This guide walks you through installing Calyx, running your first commands, and finding the right reference docs for your use case.

## Prerequisites

| Requirement | Minimum | Check |
|-------------|---------|-------|
| Node.js | >= 22.0.0 | `node --version` |
| pnpm | >= 9.0.0 | `pnpm --version` |

## Install

### Global install (recommended)

```bash
npm install -g @polli-labs/calyx
```

### One-shot via npx

```bash
npx @polli-labs/calyx --help
```

### From source (contributor path)

```bash
git clone https://github.com/polli-labs/calyx-dev.git
cd calyx-dev
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

### Verify installation

After any install method, confirm Calyx is callable:

```bash
calyx --help
```

Expected: the top-level help listing all 8 domain command groups and global flags. If you see a command-not-found error, ensure `node_modules/.bin` (npx) or your global npm bin directory is on your `PATH`.

## First commands

Calyx commands follow a consistent pattern:

```
calyx <domain> <verb> [options]
```

The 8 domains are: `config`, `instructions`, `skills`, `tools`, `prompts`, `agents`, `knowledge`, `exec`. Every command supports `--json` for machine-readable output.

### Explore a domain

Pick any domain and run its help:

```bash
calyx skills --help
```

This lists available verbs (`index`, `sync`, `validate`) with brief descriptions.

### Validate a registry

The fastest way to confirm Calyx is working end-to-end is to validate a fixture-backed registry:

```bash
calyx skills validate \
  --registry fixtures/domains/skills/registry.valid.json \
  --strict
```

**Expected:** Exit code `0`, confirming the registry passes schema validation. This command is safe (read-only) and uses bundled test fixtures — no external state or credentials required.

### Index registry entries

List entries in a registry file:

```bash
calyx skills index --registry fixtures/domains/skills/registry.valid.json
```

Add `--json` for structured output suitable for piping to `jq` or downstream tools:

```bash
calyx skills index --registry fixtures/domains/skills/registry.valid.json --json
```

### Try another domain

All five registry domains (`skills`, `tools`, `prompts`, `agents`, `knowledge`) share the same `index` / `validate` verbs. Try tools:

```bash
calyx tools index --registry fixtures/domains/tools/registry.valid.json
calyx tools validate --registry fixtures/domains/tools/registry.valid.json --strict
```

## Command surface map

Calyx has 25 canonical subcommands across 8 domains. Here's where to start for common tasks:

| I want to… | Domain | Command | Docs |
|------------|--------|---------|------|
| Compile fleet config to TOML | `config` | `calyx config compile` | [CLI Reference](cli-reference.md) |
| Render agent instructions | `instructions` | `calyx instructions render` | [CLI Reference](cli-reference.md) |
| Verify instruction parity | `instructions` | `calyx instructions verify` | [CLI Reference](cli-reference.md) |
| List/sync/validate skills | `skills` | `calyx skills index\|sync\|validate` | [CLI Reference](cli-reference.md) |
| List/sync/validate tools | `tools` | `calyx tools index\|sync\|validate` | [CLI Reference](cli-reference.md) |
| List/sync/validate prompts | `prompts` | `calyx prompts index\|sync\|validate` | [CLI Reference](cli-reference.md) |
| Manage agents | `agents` | `calyx agents index\|deploy\|sync\|validate` | [CLI Reference](cli-reference.md) |
| Search/link knowledge | `knowledge` | `calyx knowledge search\|link\|validate` | [CLI Reference](cli-reference.md) |
| Launch/track executions | `exec` | `calyx exec launch\|status\|logs\|receipt` | [CLI Reference](cli-reference.md) |

For the full command reference with all options, exit codes, and examples, see [docs/cli-reference.md](cli-reference.md).

## Exit codes

All commands use consistent exit codes:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error (file not found, parse failure) |
| `2` | Invalid CLI arguments |
| `3` | Domain validation failure |

## Migrating from legacy scripts

If you're transitioning from `dev/run/*` shell scripts, Calyx provides compatibility wrappers that emit deprecation warnings and telemetry while forwarding to canonical commands. The recommended migration path:

1. **Install Calyx** alongside legacy scripts (coexistence).
2. **Switch to wrappers** (`calyx skills-sync` instead of `dev/run/skills-sync`) to get telemetry.
3. **Adopt canonical commands** (`calyx skills sync --backend claude`) — the stable, long-term form.
4. **Remove legacy scripts** once wrapper telemetry shows zero usage.

For the complete migration walkthrough, see [Migration Guide](migration-guide.md).

For a skill-by-skill disposition of what Calyx replaces, retains, or defers, see the [Skills Subsumption Catalogue](skills-subsumption-catalogue.md).

## Building extensions

Calyx has a hook-based extension model. Extensions are npm packages that depend on `@polli-labs/calyx-sdk` and can intercept domain command lifecycle events (activate, beforeCommand, afterCommand, deactivate).

A minimal extension:

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
  },
};

export default extension;
```

Key extension concepts:

- **Naming:** `calyx-ext-<name>` (first-party) or `@user/calyx-ext-<name>` (community).
- **Manifest:** Declared in `package.json` under a `calyx` key with `apiVersion` and target `domains`.
- **Validation:** Use `validateManifest()` from `@polli-labs/calyx-sdk` to check your manifest.

For the full SDK reference, lifecycle docs, and a working example, see [Extension SDK](extension-sdk.md) and the [`calyx-ext-hello`](../examples/calyx-ext-hello) sample.

## Troubleshooting

### `calyx: command not found`

Ensure your global npm bin directory is on `PATH`:

```bash
npm bin -g
# Add this to your shell profile if not on PATH
```

Or use `npx @polli-labs/calyx` as an alternative.

### `Error: Node.js version`

Calyx requires Node.js >= 22. Check with `node --version` and upgrade if needed. We recommend using a version manager like `nvm` or `fnm`.

### `Error: Cannot find module` or registry parse failures

- Ensure you're passing a valid JSON file path to `--registry` or `--store`.
- For fixture-based commands, run from the repository root where `fixtures/` is accessible.

### Exit code 3 (validation failure)

This means the input is structurally valid but fails domain-specific validation rules. Run without `--strict` first to see advisory-level warnings, then address them before re-running with `--strict`.

### Getting more help

- `calyx --help` — Top-level command listing
- `calyx <domain> --help` — Domain-specific help
- [CLI Reference](cli-reference.md) — Exhaustive command documentation
- [Operator Runbook](operator-runbook.md) — Daily operations guide with verification checklists

## Documentation index

| Document | Best for |
|----------|----------|
| **[This guide](onboarding.md)** | First-time setup and orientation |
| [CLI Reference](cli-reference.md) | Complete command options and examples |
| [Operator Runbook](operator-runbook.md) | Daily operational workflows and verification |
| [Migration Guide](migration-guide.md) | Transitioning from legacy scripts |
| [Extension SDK](extension-sdk.md) | Building Calyx extensions |
| [Skills Subsumption Catalogue](skills-subsumption-catalogue.md) | What Calyx replaces, retains, or defers |

# Getting Started with Calyx

Calyx is a unified, contract-first CLI for managing agent infrastructure — config compilation, local runtime-config convergence, instruction rendering, skill/tool/prompt registries, agent deployment, knowledge linking, operator-facing run orchestration, and lower-level exec-store utilities. It replaces fragmented operational scripts with typed domain commands, consistent exit codes, and machine-readable output.

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

Expected: the top-level help listing the canonical command groups, including `run`, and global flags. If you see a command-not-found error, ensure `node_modules/.bin` (npx) or your global npm bin directory is on your `PATH`.

## First commands

Calyx commands follow a consistent pattern:

```
calyx <domain> <verb> [options]
```

The 8 hookable extension domains are: `config`, `instructions`, `skills`,
`tools`, `prompts`, `agents`, `knowledge`, `exec`. First-party operator
surfaces like `run` and `runtime-config` sit above those domain backends.
Data-bearing commands expose `--json` where their help documents it.

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

Skills, tools, prompts, and knowledge share the same `index` / `validate` verbs. Agents use the POL-1799 definition registry verbs `list` / `show` / `validate`. Try tools:

```bash
calyx tools index --registry fixtures/domains/tools/registry.valid.json
calyx tools validate --registry fixtures/domains/tools/registry.valid.json --strict
```

## Command surface map

Calyx has canonical command groups for extension domains, run orchestration, and operator utilities. Here's where to start for common tasks:

| I want to… | Domain | Command | Docs |
|------------|--------|---------|------|
| Compile fleet config to TOML | `config` | `calyx config compile` | [CLI Reference](cli-reference.md) |
| Converge local Codex config, Claude settings, and Claude MCP root config from managed truth | `runtime-config` | `calyx runtime-config plan\|apply\|verify` | [CLI Reference](cli-reference.md) |
| Inspect named instruction surfaces | `instructions` | `calyx instructions list\|show\|targets` | [CLI Reference](cli-reference.md) |
| Render agent instructions | `instructions` | `calyx instructions render` | [CLI Reference](cli-reference.md) |
| Verify instruction parity | `instructions` | `calyx instructions verify` | [CLI Reference](cli-reference.md) |
| List/sync/validate skills | `skills` | `calyx skills index\|sync\|validate` | [CLI Reference](cli-reference.md) |
| List/sync/validate tools | `tools` | `calyx tools index\|sync\|validate` | [CLI Reference](cli-reference.md) |
| List/render/sync/validate prompts | `prompts` | `calyx prompts index\|render\|sync\|validate` | [CLI Reference](cli-reference.md) |
| Manage agents | `agents` | `calyx agents list\|show\|validate` | [CLI Reference](cli-reference.md) |
| Search/link knowledge | `knowledge` | `calyx knowledge search\|link\|validate` | [CLI Reference](cli-reference.md) |
| Launch and track orchestrated runs | `run` | `calyx run launch\|status\|await\|receipt\|logs` | [CLI Reference](cli-reference.md) |
| Commission reviewer runs | `review` | `calyx review --repo <slug> (--pr <n>\|--branch <ref>)` | [CLI Reference](cli-reference.md) |
| Inspect low-level exec JSON stores | `exec` | `calyx exec launch\|status\|logs\|receipt` | [CLI Reference](cli-reference.md) |

For the hand-authored detailed reference, see
[docs/cli-reference.md](cli-reference.md). Runtime help remains authoritative
for the exact installed command shape.

## Exit codes

These codes are common across the first workflow; command-specific help and
the interface record define any additional meanings:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error (file not found, parse failure) |
| `2` | Invalid CLI arguments |
| `3` | Domain validation failure |

## Retired command names

Retired wrapper names fail with an actionable canonical replacement. If an old
automation invokes one, follow that error and update the caller; migration
history remains available in Git.

## Building extensions

Calyx has a hook-based extension model. Extensions are npm packages that depend on `@polli-labs/calyx-sdk` and can intercept domain command lifecycle events (activate, beforeCommand, afterCommand, deactivate).

Treat them as optional overlays, not default owners of domain semantics:

- Calyx core owns the canonical lifecycle and command contracts.
- Extensions are best suited for advisory diagnostics, harness-specific augmentation, or small environment-aware integrations.
- Shared Polli workflow/source truth still lives outside the extension layer unless a package explicitly implements that behavior.

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
- **Manifest:** Declared in `package.json` under a `calyx` key with `apiVersion` and target hookable `domains`.
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
- [CLI Reference](cli-reference.md) — Hand-authored detailed command reference
- [Operator Runbook](operator-runbook.md) — Daily operations guide with verification checklists

## Documentation index

| Document | Best for |
|----------|----------|
| **[This guide](onboarding.md)** | First-time setup and orientation |
| [CLI Reference](cli-reference.md) | Detailed command contracts currently maintained by hand |
| [Operator Runbook](operator-runbook.md) | Daily operational workflows and verification |
| [Extension SDK](extension-sdk.md) | Building Calyx extensions |

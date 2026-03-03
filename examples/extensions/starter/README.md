# Calyx Extension Starter Template

Copy this directory to start building your own Calyx extension.

## Quick start

```bash
# 1. Copy and rename
cp -r examples/extensions/starter calyx-ext-myname
cd calyx-ext-myname

# 2. Update package.json
#    - Change "name" to "calyx-ext-myname" (or "@yourorg/calyx-ext-myname")
#    - Change "description"
#    - Update "calyx.domains" to the domains you target

# 3. Install dependencies
npm install

# 4. Implement your hooks in src/index.ts

# 5. Validate your manifest
npx tsx src/validate.ts

# 6. Build
npm run build

# 7. Test with Calyx
CALYX_EXTENSIONS_PATH=$(dirname $(pwd)) calyx extensions list
```

## Extension lifecycle

```
load → activate → (beforeCommand → command → afterCommand)* → deactivate
```

- **activate**: One-time setup, environment validation
- **beforeCommand**: Pre-command checks; return `{ ok: false }` to abort
- **afterCommand**: Post-command telemetry, diagnostics
- **deactivate**: Cleanup on CLI exit

All hooks are optional — remove any you don't need.

## Available domains

| Domain | Description |
|--------|-------------|
| `config` | Fleet/host YAML compilation |
| `instructions` | Template rendering |
| `skills` | Skills registry management |
| `tools` | Tools registry management |
| `prompts` | Prompts registry management |
| `agents` | Agent profiles and deployment |
| `knowledge` | Knowledge artifact management |
| `exec` | Execution lifecycle |

## Naming convention

| Scope | Pattern |
|-------|---------|
| First-party | `calyx-ext-<name>` |
| Community | `@yourorg/calyx-ext-<name>` |

## Reference

- [Extension SDK docs](https://github.com/polli-labs/calyx/blob/main/docs/extension-sdk.md)
- [Example: calyx-ext-hello](../calyx-ext-hello/) — minimal reference
- [First-party: calyx-ext-polli](../../../packages/calyx-ext-polli/) — production example

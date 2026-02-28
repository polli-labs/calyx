# Release Candidate Checklist and Runbook

Version: v0.1.0-rc.1
Date: 2026-02-28

## Pre-release checklist

### Code quality gates

- [ ] `pnpm lint` passes with zero errors
- [ ] `pnpm typecheck` passes across all packages
- [ ] `pnpm test` passes (all test suites green)
- [ ] `pnpm build` succeeds for all packages

### Package verification

- [ ] `packages/core` exports all domain contracts and functions
- [ ] `packages/cli` builds bin with shebang, `calyx --help` works
- [ ] `packages/sdk` exports extension contracts, `validateManifest` works
- [ ] `packages/web` builds (placeholder OK for RC)
- [ ] `examples/calyx-ext-hello` typechecks against SDK

### Documentation verification

- [ ] `docs/cli-reference.md` covers all 8 domain command groups + wrappers
- [ ] `docs/extension-sdk.md` documents SDK contracts, lifecycle, and quick start
- [ ] `docs/migration-guide.md` covers legacy → calyx transition
- [ ] `docs/migration-wrappers.md` documents all implemented wrappers
- [ ] `docs/adr/adr-0002-repo-structure-and-build.md` is current
- [ ] `README.md` frames package boundaries and extension model

### CI/CD verification

- [ ] `ci.yml` runs lint, typecheck, test, build
- [ ] `smoke.yml` runs CLI help on ubuntu + macos
- [ ] `release.yml` publish job is wired for tag-triggered publishing

### Fixture corpus

- [ ] Config compiler fixtures: blade, carbon, worm, mba (inputs + expected)
- [ ] Instructions fixtures: blade, worm (templates, partials, expected, drift)
- [ ] Domain fixtures: skills, tools, prompts, agents, knowledge, exec (valid + invalid)

## Release process

### 1. Final verification

```bash
# In the calyx-dev repo:
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# Smoke test CLI
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js config --help
node packages/cli/dist/bin.js skills --help
```

### 2. Version bump

All packages are at `0.1.0`. For the RC:

```bash
# Update all package.json versions to 0.1.0-rc.1
# (or use pnpm's version management)
```

### 3. Tag and push

```bash
git tag v0.1.0-rc.1
git push origin v0.1.0-rc.1
```

This triggers `release.yml`, which runs full CI gates and publishes to npm.

### 4. Verify publication

```bash
npm info @polli-labs/calyx-core@0.1.0-rc.1
npm info @polli-labs/calyx@0.1.0-rc.1
npm info @polli-labs/calyx-sdk@0.1.0-rc.1
```

### 5. Smoke test published packages

```bash
# In a clean directory:
npm install @polli-labs/calyx@0.1.0-rc.1
npx calyx --help
npx calyx config --help
```

### 6. Promote to public repo (optional for RC)

```bash
# From calyx-dev:
git remote add public git@github.com:polli-labs/calyx.git  # if not already
git push public main
git push public v0.1.0-rc.1
```

## Rollback

If a critical issue is found after publishing the RC:

1. **Deprecate** the bad version on npm: `npm deprecate @polli-labs/calyx@0.1.0-rc.1 "Known issue: ..."`
2. Fix the issue on a new branch.
3. Tag and publish the next RC: `v0.1.0-rc.2`.

Do not unpublish — npm's unpublish window is short and causes dependency resolution issues for anyone who already installed the version.

## Post-RC

After the RC is validated:

- Collect feedback from internal users.
- Address any issues found during RC testing.
- When ready, promote to GA: tag `v0.1.0` and publish without the `-rc` suffix.
- Update `CHANGELOG.md` with release notes.
- Post receipts to POL-639 and POL-605.

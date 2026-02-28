# Release Candidate Checklist and Runbook

Version: v0.1.0-rc.1
Date: 2026-02-28

## Pre-release checklist

### Code quality gate

Run the canonical verification command:

```bash
pnpm verify   # lint → typecheck → test → build
```

All four stages must pass. See [CI Reliability Runbook](ci-reliability-runbook.md) for failure classification and override policy.

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
- [ ] `docs/ci-reliability-runbook.md` is current
- [ ] `docs/adr/adr-0002-repo-structure-and-build.md` is current
- [ ] `README.md` frames package boundaries and extension model

### CI/CD verification

- [ ] `ci.yml` runs `pnpm verify`
- [ ] `smoke.yml` runs CLI help on ubuntu + macos
- [ ] `release.yml` publish job runs `pnpm verify` before publish

### Fixture corpus

- [ ] Config compiler fixtures: blade, carbon, worm, mba (inputs + expected)
- [ ] Instructions fixtures: blade, worm (templates, partials, expected, drift)
- [ ] Domain fixtures: skills, tools, prompts, agents, knowledge, exec (valid + invalid)

## Release process

### 1. Final verification

```bash
pnpm install --frozen-lockfile
pnpm verify
```

Smoke test the CLI manually:

```bash
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

This triggers `release.yml`, which runs `pnpm verify` and publishes to npm.

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

## Promotion paths

### First public bootstrap (calyx-dev → calyx)

Used for initial promotion of `calyx-dev` to the public `calyx` repo. This was executed during P6A.

1. Ensure `pnpm verify` passes on the `calyx-dev` main branch.
2. Add the public remote if not already configured:
   ```bash
   git remote add public git@github.com:polli-labs/calyx.git
   ```
3. Push main branch to public:
   ```bash
   git push public main
   ```
4. Push tags:
   ```bash
   git push public v0.1.0-rc.1
   ```
5. Verify CI runs on the public repo. If GitHub Actions are blocked by billing/spend limits, follow the [CI Reliability Runbook](ci-reliability-runbook.md) outage override protocol.
6. Post receipts to the tracking Linear issue.

### Steady-state PR promotion (ongoing)

Used for all subsequent changes after initial bootstrap.

1. Create a feature branch in `calyx-dev` and open a PR against `main`.
2. CI (`pnpm verify` + smoke) must pass. If CI is unavailable due to infrastructure issues, follow the [CI Reliability Runbook](ci-reliability-runbook.md).
3. Merge the PR into `calyx-dev` main.
4. Promote to public:
   ```bash
   git push public main
   ```
5. For releases, tag and push the tag to both remotes:
   ```bash
   git tag v<version>
   git push origin v<version>
   git push public v<version>
   ```

### When to use which path

| Scenario | Path |
|---|---|
| Public repo has no commits yet | First public bootstrap |
| Public repo already has main branch | Steady-state PR promotion |
| Hotfix needed on public repo | Steady-state (branch from main, PR, merge, push public) |

## Rollback

### Code rollback

If a critical issue is found after publishing the RC:

1. **Deprecate** the bad version on npm: `npm deprecate @polli-labs/calyx@0.1.0-rc.1 "Known issue: ..."`
2. Fix the issue on a new branch.
3. Tag and publish the next RC: `v0.1.0-rc.2`.

Do not unpublish — npm's unpublish window is short and causes dependency resolution issues for anyone who already installed the version.

### Promotion rollback

If a bad commit was pushed to the public repo:

1. Revert the commit in `calyx-dev` via a revert PR.
2. After merge, push the revert to public: `git push public main`.
3. Do not force-push the public repo. Use revert commits to maintain clean history.

## Post-RC

After the RC is validated:

- Collect feedback from internal users.
- Address any issues found during RC testing.
- When ready, promote to GA: tag `v0.1.0` and publish without the `-rc` suffix.
- Update `CHANGELOG.md` with release notes.
- Post receipts to POL-639 and POL-605.

## Related documents

- [CI Reliability Runbook](ci-reliability-runbook.md) — failure taxonomy, decision tree, override protocol
- [README](../README.md) — local verification instructions

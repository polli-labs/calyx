# POL-672 Release Receipts

## GA Version: 0.1.1 (Path B)

## Timeline

| Step | Status | Timestamp | Evidence |
|------|--------|-----------|----------|
| Version bump (0.1.0 → 0.1.1) | Done | 2026-03-02T21:48Z | `bed59d2` |
| Local quality gate (pnpm verify) | Pass | 2026-03-02T21:48Z | lint + typecheck + 122 tests + build |
| PR opened (calyx-dev) | Done | 2026-03-02T21:49Z | [calyx-dev#13](https://github.com/polli-labs/calyx-dev/pull/13) |
| CI on PR | Pass | 2026-03-02T21:50Z | verify (40s), smoke/ubuntu (28s), smoke/macos (28s) |
| PR merged | Done | 2026-03-02T21:51Z | `741e608` on origin/main |
| Public promotion | Done | 2026-03-02T21:51Z | [calyx#7](https://github.com/polli-labs/calyx/pull/7) → `ac82024` |
| GA tag pushed (v0.1.1) | Done | 2026-03-02T21:52Z | `v0.1.1` → `ac82024` on public |
| Release workflow | Pass | 2026-03-02T21:53Z | [Run 22597350656](https://github.com/polli-labs/calyx/actions/runs/22597350656) — ci (25s) + publish (35s) |
| npm publish verification | Pass | 2026-03-02T21:53Z | All 4 packages at 0.1.1 latest |
| Provenance verification | Pass | 2026-03-02T21:53Z | SLSA v1 provenance + npm signatures |
| CLI smoke test | Pass | 2026-03-02T21:54Z | `npx calyx --help` successful |

## Package Version Contract

| Package | Target | npm Status | latest dist-tag | Publish Time |
|---------|--------|------------|-----------------|--------------|
| @polli-labs/calyx-core | 0.1.1 | Published | 0.1.1 | 2026-03-02T21:53:08Z |
| @polli-labs/calyx-sdk | 0.1.1 | Published | 0.1.1 | 2026-03-02T21:53:12Z |
| @polli-labs/calyx | 0.1.1 | Published | 0.1.1 | 2026-03-02T21:53:16Z |
| @polli-labs/calyx-web | 0.1.1 | Published | 0.1.1 | 2026-03-02T21:53:20Z |

## Trusted Publishing Contract

- Auth method: GitHub OIDC (`id-token: write`)
- NPM_TOKEN: Not used (empty string per policy)
- Provenance flag: `--provenance` on all publish steps
- Attestation: SLSA v1 provenance predicate confirmed on all 4 packages
- npm registry signatures: Present on all 4 packages (key `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`)

## Provenance URLs

- [@polli-labs/calyx-core](https://registry.npmjs.org/-/npm/v1/attestations/@polli-labs%2fcalyx-core@0.1.1)
- [@polli-labs/calyx-sdk](https://registry.npmjs.org/-/npm/v1/attestations/@polli-labs%2fcalyx-sdk@0.1.1)
- [@polli-labs/calyx](https://registry.npmjs.org/-/npm/v1/attestations/@polli-labs%2fcalyx@0.1.1)
- [@polli-labs/calyx-web](https://registry.npmjs.org/-/npm/v1/attestations/@polli-labs%2fcalyx-web@0.1.1)

## CLI Smoke Test

```
$ npm install @polli-labs/calyx@0.1.1 (from registry.npmjs.org)
added 6 packages, and audited 7 packages in 1s
found 0 vulnerabilities

$ npx calyx --help
Usage: calyx [options] [command]
Calyx control plane CLI
...
```

## Tag Sync

| Remote | Tag | SHA |
|--------|-----|-----|
| public | v0.1.1 | ac82024 |
| origin | (pending push) | — |

## Notes

- Decision rationale: See `outputs/pol-672-ga-decision.md`
- Baseline evidence: See `outputs/pol-672-baseline.md` and `outputs/pol-672-npm-baseline.md`
- Local CLI smoke required `.npmrc` override due to host `@polli-labs:registry` config pointing at GitHub Packages; public consumers installing from npmjs.org will not encounter this.

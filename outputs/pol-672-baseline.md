# POL-672 Baseline Audit

Captured: 2026-03-02

## Git Log (last 10 commits)

```
4738bdd (HEAD) feat(wrappers): legacy wrapper guardrails + deprecation telemetry (POL-671) (#12)
24f2c47 docs: P7A-2 operator runbook cutover + dry-run receipts (POL-670) (#11)
963bd37 feat: P6C CI signal revalidation receipts + promotion parity (POL-642) (#10)
e1031d5 feat: P6B CI reliability governance + promotion hardening (POL-641) (#9)
bb0eb69 feat: P6A public promotion + release hardening (POL-640) (#8)
ac1b887 (tag: v0.1.0-rc.1) feat: P5 publishability + release candidate lane (POL-639) (#7)
9276913 feat: P4 migration wrappers + docs coherence sweep (POL-638) (#6)
df4b203 feat: P3B exec lifecycle proving lane (POL-637) (#5)
2981010 feat: P3A agents + knowledge proving lane (POL-633) (#4)
c9bba0e feat: add skills/tools/prompts domains and skills-sync wrapper seed (#3)
```

## Remotes

| Remote | URL |
|--------|-----|
| origin | https://github.com/polli-labs/calyx-dev.git |
| public | git@github.com:polli-labs/calyx.git |

## Local Tags

```
v0.1.0-auth-smoke-20260302
v0.1.0-rc.1
v0.1.1-trusted.0
v0.1.2-trusted.0
v0.1.3-trusted.0
v0.1.4-trusted.0
v0.1.5-trusted.0
```

## Public Remote Tags

```
v0.1.0-auth-smoke-20260302
v0.1.0-rc.1
v0.1.1-trusted.0
v0.1.2-trusted.0
v0.1.3-trusted.0
v0.1.4-trusted.0
v0.1.5-trusted.0
```

Note: No `v0.1.0` GA tag exists on either remote.

## Origin Remote Tags

```
v0.1.0-rc.1
```

Note: Only RC tag exists on origin; smoke/trusted tags are public-only.

## Package Versions (pre-release)

| Package | Version |
|---------|---------|
| calyx-dev (root) | 0.1.0 |
| @polli-labs/calyx-core | 0.1.0 |
| @polli-labs/calyx-sdk | 0.1.0 |
| @polli-labs/calyx | 0.1.0 |
| @polli-labs/calyx-web | 0.1.0 |

## Release Workflow

- File: `.github/workflows/release.yml`
- Trigger: push tags matching `v*.*.*`
- Jobs: `ci` (verify) → `publish` (pnpm publish with `--provenance`)
- Auth: trusted publishing (OIDC, `id-token: write`; `NODE_AUTH_TOKEN: ""`)
- No skip-if-exists logic present.

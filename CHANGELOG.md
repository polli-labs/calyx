# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `calyx self upgrade` now transparently preserves classifier-proven restart-safe runs by default, drains healthy unproven runs, and refuses named blockers. Use `--drain-all` to force a full drain; `--continuous` is a deprecated warn-once no-op alias scheduled for removal in `0.4.0`.

## [0.2.0] - 2026-03-23

### Added
- **Symphony-spec daemon** for durable run orchestration (`packages/run-service`)
- **Codex app-server JSON-RPC client** and streaming adapter (`packages/calyx-ext-codex`)
- **BackendAdapter interface** for streaming and turn-level control
- **Session discovery** with terminal message extraction and log enrichment
- **Budget exhaustion classification** with `partial` terminal state and classifier pipeline
- **`calyx run resume`** for resuming existing backend sessions
- **`calyx-ext-linear`** extension for advisory Linear context hints
- **`calyx-ext-cursor`** extension for harness-target Cursor hints
- **Repo-maintained skill** at `skills/calyx-dev/` with architecture and extension references
- **AGENTS.md** and **CLAUDE.md** for agent orientation

### Changed
- Extracted codex-specific adapter code from runner into `calyx-ext-codex`
- Rebuilt `calyx run` around codex app-server (replacing legacy exec adapter)
- Tracker registry now supports multi-turn execution
- Run logs enriched with session terminal messages and timing data

### Fixed
- `calyx run logs --full` flag for untruncated terminal messages
- Timing buffer for cross-process timestamp correlation
- Codex parser `response_item` type check for streaming events

## [0.1.1] - 2026-03-18

### Added
- Runner adapter hardening with maxBuffer, signal detection, stderr persistence
- ADR-0001 and POL-605 planning artifacts promoted from work repo

## [0.1.0] - 2026-03-06

### Added
- Initial release: contract-first CLI, extension SDK, run orchestration
- Core domain: config, instructions, skills, tools, prompts, agents, knowledge, exec
- Extension model with advisory hooks and runtime factories
- Fleet convergence commands (fleet apply, fleet smoke, doctor)
- Cross-host smoke framework
- Staged render drift validator

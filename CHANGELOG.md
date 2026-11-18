# Changelog

## 0.5.2 — 2026-11-18

First standalone DSH Codex Bridge project, extracted from the standard-plugin branch of Codex DeepSeek Bridge. Keeps the `peerbridge-dsh-plugin` package identity for upgrades.

Fixes registration recovery, ownership-aware offline cleanup, lifecycle rollback, concurrent HTTP session disposal, plugin name collisions, pending-question validation and cancellation, and partial creation receipts. Adds cross-review regression tests and isolated real-host coexistence/uninstall validation. See [review notes](docs/review.md) and [cleanup guide](docs/uninstall.md).

## Earlier versions

0.5.0 introduced the standard single-install DSH bundle. 0.5.1 used native per-call Codex and DSH host context for source attribution. Earlier development history remains in [the original repository](https://github.com/qiuYliangM/codex-deepseek-bridge/tree/feat/dsh-single-install).

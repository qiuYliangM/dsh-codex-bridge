# Changelog

## 0.5.3 — 2026-11-27

Distinguishes Codex backend session creation and bridge-only empty-session discovery from native-list and live UI visibility. Preserves created IDs when the visibility check fails and provides a local desktop link when available. After queue acceptance, requests the matching desktop's background wake route so a cold thread can consume its queued message. Failed or unavailable wake retains the original acceptance receipt and warns against resending; a launch request is never reported as confirmed delivery.

## 0.5.2 — 2026-11-18

First standalone DSH Codex Bridge project, extracted from the standard-plugin branch of Codex DeepSeek Bridge. Keeps the `peerbridge-dsh-plugin` package identity for upgrades.

Fixes registration recovery, ownership-aware offline cleanup, lifecycle rollback, concurrent HTTP session disposal, plugin name collisions, pending-question validation and cancellation, and partial creation receipts. Adds cross-review regression tests and isolated real-host coexistence/uninstall validation. See [review notes](docs/review.md) and [cleanup guide](docs/uninstall.md).

## Earlier versions

0.5.0 introduced the standard single-install DSH bundle. 0.5.1 used native per-call Codex and DSH host context for source attribution. Earlier development history remains in [the original repository](https://github.com/qiuYliangM/codex-deepseek-bridge/tree/feat/dsh-single-install).

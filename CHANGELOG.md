# Changelog

All notable changes. Versions follow [semver](https://semver.org); tags are `vX.Y.Z`.

## Unreleased

## 0.1.0 - 2026-11-10

- Sweep detached processes and `omp.session`-labelled containers every minute.
- Close abandoned headless browsers and kinds you marked "close"; record the rest for `/reaper review`.
- Ask the owning agent about its own leftovers via `reaper_hold`; notify you after `maxAsks` unanswered asks.
- Settings via `omp plugin config`: `dryRun`, `graceMinutes`, `maxAsks`, `closeHeadlessBrowsers`.

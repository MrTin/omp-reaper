# omp-reaper: agent instructions

An omp extension. Bun + TypeScript, no build step, no runtime dependencies.

## Layout

| File | Role | Rule |
|---|---|---|
| `src/scan.ts` | Parsing and the decision table (`classify`) | Pure: no I/O. Every behaviour change gets a case in `test/scan.test.ts` |
| `src/system.ts` | OS boundary: `ps`, `docker`, `omp session lease` | Takes `exec`; covered by `test/system.test.ts` against the real process table |
| `src/store.ts` | Settings, decisions, sightings, log | Settings are declared once in `package.json#omp.settings`; never hardcode a default here |
| `src/index.ts` | omp wiring: timer, `reaper_hold` tool, `/reaper` command | Keep logic out of it; move it to `scan.ts` and test it |

## Commands

```bash
bun install          # dev types only
bun test             # unit + integration (the lease test skips without omp on PATH)
bun run check        # tsc --noEmit
omp plugin link .    # load this checkout in omp; restart omp after changes
```

## Rules

- Never close something `classify` did not return `reap` for. Unknown ownership means leave it.
- A new setting goes in `package.json#omp.settings` with `default`, `env` (`OMP_REAPER_*`) and `description`, plus a row in the README settings table.
- Commit no personal paths, session ids, hostnames or credentials. Tests use fake ids and temp dirs (`test/setup.ts`).
- No runtime dependencies. `@oh-my-pi/*` imports resolve to the host omp at runtime.

## Workflow

`main` is protected: no direct pushes (admins included), CI (`test (ubuntu-latest)`, `test (macos-latest)`) must pass, linear history, squash merge only, branches auto-deleted after merge.

```bash
git checkout main && git pull
git checkout -b <type>/<short-description>   # feat/ fix/ chore/ docs/ test/
# ... change, add a CHANGELOG "Unreleased" line if users notice it ...
git push -u origin HEAD
gh pr create --fill
gh pr merge --squash --auto                  # merges once CI is green
```

PR title = the squash commit subject, so write it as a Conventional Commit: `fix: …`, `feat: …`.

## Releasing

Releases are cut from `main`, through a PR like any other change:

1. Branch `release/vX.Y.Z`. Move the `Unreleased` entries in `CHANGELOG.md` under `## X.Y.Z - YYYY-MM-DD`.
2. `npm version X.Y.Z --no-git-tag-version` (bumps `package.json`), commit, PR titled `release: vX.Y.Z`, squash-merge.
3. Tag the merged commit: `git checkout main && git pull && git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The `release` workflow creates the GitHub Release from that CHANGELOG section.
5. Once published to npm: `npm publish --access public`. The `omp-plugin` keyword lists it on [omppackages.com](https://omppackages.com).

Patch: fixes. Minor: new behaviour or setting. Major: a setting removed or renamed, or a default that closes more than before.

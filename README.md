# omp-reaper

Your agents start things. The reaper finishes them.

An [omp](https://github.com/can1357/oh-my-pi) extension that finds processes and containers agents left running after their session ended. It closes the ones it is sure about, asks the owning agent about the rest, and learns from your answers.

```text
[reaper] Started from this session and still running:
- pid:48213  node vite  `node node_modules/.bin/vite --port 5173`
If one is no longer needed, stop it or call `reaper_hold` with `minutes: 0`.
```

## Install

```bash
omp plugin install github:MrTin/omp-reaper          # latest
omp plugin install 'github:MrTin/omp-reaper#v0.1.0' # pinned
```

Restart omp. Check it loaded:

```bash
omp plugin list                     # ● omp-reaper@0.1.0
omp plugin config list omp-reaper   # settings and their current values
```

Or from the marketplace catalog in this repo:

```text
/marketplace add MrTin/omp-reaper
/marketplace install reaper@omp-reaper
```

## Tweak

```bash
omp plugin config set omp-reaper dryRun true            # log only, close nothing
omp plugin config set omp-reaper graceMinutes 30        # wait longer before asking
omp plugin config set omp-reaper maxAsks 0              # never ask agents, just notify
omp plugin config set omp-reaper closeHeadlessBrowsers false
omp plugin config delete omp-reaper graceMinutes        # back to default
```

| Setting | Default | Env | Meaning |
|---|---|---|---|
| `dryRun` | `false` | `OMP_REAPER_DRY_RUN` | Log what would be closed to `reaper.log` instead of closing it |
| `graceMinutes` | `10` | `OMP_REAPER_GRACE_MINUTES` | Wait before the first ask, between asks, and on top of a hold |
| `maxAsks` | `2` | `OMP_REAPER_MAX_ASKS` | Unanswered asks before you get a notification instead |
| `closeHeadlessBrowsers` | `true` | `OMP_REAPER_CLOSE_BROWSERS` | Close abandoned headless Chrome/Chromium without asking |

A saved setting wins over its env var. Settings are read every sweep, so no restart is needed.

## Teach it

Unknown leftovers are recorded, not closed. Answer once and it remembers that kind of process:

```text
/reaper review       # close / keep / skip, one per kind
/reaper decisions    # change or forget an answer
/reaper              # what it is watching, recent actions
```

Answers live in `~/.omp/agent/reaper/decisions.json`, keyed by a signature (executable plus up to two arguments, hashes and numbers masked). An agent can seed them directly:

```json
{
	"node vite": { "decision": "reap", "at": 0 },
	"ngrok http": { "decision": "keep", "at": 0 }
}
```

## Give your agents the rules

Add to `~/.omp/agent/RULES.md`:

```markdown
- Long-lived processes: bash tool `name` service only. NEVER `&`, `nohup`, `disown`, `setsid`.
- Browsers: `browser.open` with the default managed Chromium. If `app.path` is unavoidable, `browser.close({ kill: true })` before yielding.
- Docker: `docker run --rm --label omp.session="$PI_SESSION_ID" …`. Stop what you started unless asked to keep it.
- A `[reaper]` message about processes you left running: answer with `reaper_hold` (`minutes: 0` if done).
```

The `omp.session` label is how the reaper ties a container to a session. Unlabelled containers, compose stacks included, are never touched.

## How it decides

Every command omp's bash tool runs inherits `PI_SESSION_ID`, and that survives the process being re-parented (to PID 1, or a Linux subreaper such as `systemd --user`). Each minute the reaper asks omp (`omp session lease`) whether that session is still open.

| Process | Action |
|---|---|
| Under a live omp process (tracked job, service, worker) | Ignored |
| Session ended, headless browser or a kind you marked "close" | Closed (SIGTERM, then SIGKILL) |
| Session ended, kind you marked "keep" | Left running |
| Session ended, unknown kind | Recorded for `/reaper review` |
| Session is this one, or its subagent | Agent asked after `graceMinutes`, only when idle |
| Session belongs to another open session | Left to that session |
| Ownership unknown, or detached under 2 minutes ago | Ignored |

One omp process at a time closes and records, so five open sessions never act five times.

## Files

Everything stays local, in `~/.omp/agent/reaper/`.

| File | Growth |
|---|---|
| `decisions.json` | one entry per answer |
| `state.json` | undecided kinds; dropped after 30 days unseen, capped at 200 |
| `reaper.log` | JSON lines, rotated at 512 KB with one backup |
| `leader.json` | fixed |

Stored command lines are cut at 200 characters with tokens, passwords and `user:pass@` masked.

## Limits

- macOS and Linux.
- Processes started outside omp's bash tool carry no session marker and are ignored (except throwaway-profile headless browsers).
- macOS hides the environment of SIP-protected system binaries such as `/bin/sleep`; those are ignored too.
- An `app.path` browser whose omp is still running looks owned, not abandoned ([oh-my-pi#15953](https://github.com/can1357/oh-my-pi/issues/15953)).

## Develop

```bash
bun install && bun test && bun run check
omp plugin link .
```

See [AGENTS.md](AGENTS.md) for layout, rules and releasing.

## License

MIT

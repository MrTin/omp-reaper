// omp-reaper: close processes agents leave behind.
//
// Every bash-tool child inherits PI_SESSION_ID / PI_SESSION_FILE, and that
// environment survives re-parenting to launchd/init. Each sweep looks at
// detached processes (ppid 1) and `omp.session`-labelled containers:
//   - owner session ended, known kind (headless browser, or you said "close") -> closed
//   - owner session ended, unknown kind -> recorded; `/reaper review` asks you once
//   - owner session is this one (or its subagent) -> the agent is asked how long it needs
//   - owned by another live session -> left to that session's reaper

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as os from "node:os";
import {
	type ClassifyInput,
	type Container,
	type Proc,
	classify,
	containerSignature,
	descendants,
	detachedRoots,
	redact,
	signature,
} from "./scan.ts";
import {
	alive,
	loadSettings,
	loadDecisions,
	loadState,
	log,
	readLog,
	recordSighting,
	saveDecisions,
	saveState,
	tryLead,
} from "./store.ts";
import { listContainers, listProcs, queryLeases } from "./system.ts";

const TICK_MS = 60_000;
const FIRST_TICK_MS = 10_000;
/** Detached for less than this: may still be starting up or about to exit on its own. */
const ORPHAN_MIN_AGE_SEC = 120;
const MIN_GRACE_MINUTES = 1;
const DOCKER_EVERY_TICKS = 5;
const KILL_GRACE_MS = 5_000;

interface Tracked {
	id: string;
	pid?: number;
	containerId?: string;
	sig: string;
	command: string;
	nextCheck: number;
	unanswered: number;
	escalated: boolean;
}

interface Item extends ClassifyInput {
	id: string;
	pid?: number;
	containerId?: string;
	rssKb: number;
}

const home = os.homedir();

/** Setting `graceMinutes`: wait before the first ask, between asks, and on top of a hold. */
const graceSec = () => Math.max(MIN_GRACE_MINUTES, loadSettings().graceMinutes) * 60;

async function reapItem(pi: ExtensionAPI, item: Item, procs: Proc[], reason: string): Promise<void> {
	if (loadSettings().dryRun) {
		log({ action: "dry-reap", sig: item.sig, id: item.id, reason, command: redact(item.command) });
		return;
	}
	if (item.containerId) {
		await pi.exec("docker", ["rm", "-f", item.containerId], { timeout: 30_000 });
	} else if (item.pid) {
		const pids = [item.pid, ...descendants(procs, item.pid)];
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
		await Bun.sleep(KILL_GRACE_MS);
		for (const pid of pids.filter(alive)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
	log({ action: "reap", sig: item.sig, id: item.id, reason, command: redact(item.command) });
}

const fmtAge = (sec: number) =>
	sec >= 86400 ? `${Math.floor(sec / 86400)}d` : sec >= 3600 ? `${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 60)}m`;

export default function reaper(pi: ExtensionAPI) {
	if (process.platform === "win32") return;
	const z = pi.zod;
	// Closure state is per session: the factory is rebound for every session.
	const tracked = new Map<string, Tracked>();
	let containers: Container[] = [];
	let lastProcs: Proc[] = [];
	let tick = 0;
	let running = false;

	async function sweep(ctx: ExtensionContext): Promise<void> {
		if (running) return;
		running = true;
		try {
			const now = Date.now();
			tick++;
			const settings = loadSettings();
			const grace = graceSec();
			const procs = await listProcs(pi.exec);
			lastProcs = procs;
			if (tick % DOCKER_EVERY_TICKS === 1) containers = await listContainers(pi.exec, now);

			const items: Item[] = [
				...detachedRoots(procs, process.pid).map(p => ({
					id: `pid:${p.pid}`,
					pid: p.pid,
					command: p.command,
					sig: signature(p.command),
					ageSec: p.ageSec,
					rssKb: p.rssKb,
					sessionId: p.sessionId,
					sessionFile: p.sessionFile,
				})),
				...containers.map(c => ({
					id: `ctr:${c.id}`,
					containerId: c.id,
					command: `${c.image} (${c.name})`,
					sig: containerSignature(c.image),
					ageSec: c.ageSec,
					rssKb: 0,
					sessionId: c.sessionId,
				})),
			];
			const ids = [...new Set(items.flatMap(i => (i.sessionId ? [i.sessionId] : [])))];
			const leases = await queryLeases(pi.exec, ids);
			const decisions = loadDecisions();
			const leader = tryLead(now, TICK_MS * 3);
			const state = leader ? loadState() : undefined;
			const seen = new Set<string>();

			for (const item of items) {
				const verdict = classify(item, {
					home,
					mySessionId: ctx.sessionManager.getSessionId(),
					mySessionFile: ctx.sessionManager.getSessionFile(),
					minAgeSec: ORPHAN_MIN_AGE_SEC,
					closeBrowsers: settings.closeHeadlessBrowsers,
					lease: id => leases.get(id) ?? "unknown",
					decision: sig => decisions[sig]?.decision,
				});
				if (verdict.kind === "reap" && leader) await reapItem(pi, item, procs, verdict.reason);
				if (verdict.kind === "record" && state) {
					recordSighting(state, item.sig, item.id, redact(item.command), item.rssKb, now);
				}
				if (verdict.kind === "mine") {
					seen.add(item.id);
					if (!tracked.has(item.id)) {
						tracked.set(item.id, {
							id: item.id,
							pid: item.pid,
							containerId: item.containerId,
							sig: item.sig,
							command: item.command,
							nextCheck: now + Math.max(0, grace - item.ageSec) * 1000,
							unanswered: 0,
							escalated: false,
						});
					}
				}
			}
			if (state) saveState(state, now);
			for (const id of tracked.keys()) if (!seen.has(id)) tracked.delete(id);
			askAgent(ctx, now);
		} finally {
			running = false;
		}
	}

	function askAgent(ctx: ExtensionContext, now: number): void {
		const due = [...tracked.values()].filter(t => !t.escalated && now >= t.nextCheck);
		const { maxAsks } = loadSettings();
		const grace = graceSec();
		for (const t of due.filter(t => t.unanswered >= maxAsks)) {
			t.escalated = true;
			log({ action: "escalate", sig: t.sig, id: t.id, command: redact(t.command) });
			ctx.ui.notify(`reaper: agent did not answer about ${t.id} (${t.sig}). See /reaper.`, "warning");
		}
		const ask = due.filter(t => t.unanswered < maxAsks);
		// Never interrupt a running turn; wait for the next idle tick.
		if (ask.length === 0 || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const lines = ask.map(t => `- ${t.id}  ${t.sig}  \`${redact(t.command)}\``);
		for (const t of ask) {
			t.unanswered++;
			t.nextCheck = now + grace * 1000;
			log({ action: "ask", sig: t.sig, id: t.id });
		}
		pi.sendMessage(
			{
				customType: "reaper.ask",
				display: true,
				content: [
					"[reaper] Started from this session and still running:",
					...lines,
					"",
					"If one is no longer needed, stop it or call `reaper_hold` with `minutes: 0`.",
					`If it is still needed, call \`reaper_hold\` with the minutes you need; I check again after that plus ${grace / 60}.`,
					"If the user asked to keep it running, say so and call `reaper_hold` with a long duration.",
				].join("\n"),
			},
			{ triggerTurn: true },
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return; // the main session sweeps for its subagents too
		ctx.setTimeout(() => void sweep(ctx), FIRST_TICK_MS);
		ctx.setInterval(() => void sweep(ctx), TICK_MS);
		const state = loadState();
		const pending = Object.keys(state.sightings).length;
		const now = Date.now();
		if (ctx.hasUI && pending > 0 && now - (state.lastNotified ?? 0) > 24 * 3600 * 1000) {
			ctx.ui.notify(`reaper: ${pending} kind(s) of lingering process to review. Run /reaper review.`, "info");
			saveState({ ...state, lastNotified: now }, now);
		}
	});

	pi.registerTool({
		name: "reaper_hold",
		label: "Reaper Hold",
		description:
			"Answer a [reaper] question about processes this session left running. minutes: 0 stops them now; otherwise reaper asks again after that many minutes plus 10.",
		loadMode: "essential",
		parameters: z.object({
			ids: z.array(z.string()).describe("Ids from the [reaper] message, e.g. pid:1234 or ctr:abc123"),
			minutes: z.number().int().min(0).describe("Minutes still needed; 0 = done, stop now"),
		}),
		async execute(_toolCallId, params: { ids: string[]; minutes: number }) {
			const now = Date.now();
			const out: string[] = [];
			for (const id of params.ids) {
				const t = tracked.get(id);
				if (!t) {
					out.push(`${id}: not tracked (already gone?)`);
					continue;
				}
				if (params.minutes === 0) {
					const item: Item = { ...t, ageSec: 0, rssKb: 0 };
					await reapItem(pi, item, lastProcs, "agent: done");
					tracked.delete(id);
					out.push(`${id}: stopped`);
				} else {
					const grace = graceSec();
					t.nextCheck = now + (params.minutes * 60 + grace) * 1000;
					t.unanswered = 0;
					t.escalated = false;
					log({ action: "hold", sig: t.sig, id, minutes: params.minutes });
					out.push(`${id}: held ${params.minutes}m, next check in ${params.minutes + grace / 60}m`);
				}
			}
			return { content: [{ type: "text", text: out.join("\n") }], details: { results: out } };
		},
	});

	pi.registerCommand("reaper", {
		description: "Lingering processes: status | review | decisions",
		handler: async (args, ctx) => {
			const [sub = "status"] = args.trim().split(/\s+/);

			if (sub === "review") {
				const state = loadState();
				const decisions = loadDecisions();
				const pending = Object.entries(state.sightings).sort(([, a], [, b]) => b.instances - a.instances);
				if (pending.length === 0) {
					ctx.ui.notify("reaper: nothing to review", "info");
					return;
				}
				const CLOSE = "Close it when its session has ended";
				const KEEP = "Keep it (never close)";
				for (const [sig, s] of pending) {
					const title = `${sig}\n${s.example}\nseen ${s.instances}x, last ${fmtAge((Date.now() - s.lastSeen) / 1000)} ago, up to ${Math.round(s.maxRssKb / 1024)} MB`;
					const choice = await ctx.ui.select(title, [CLOSE, KEEP, "Skip", "Stop reviewing"]);
					if (!choice || choice === "Stop reviewing") break;
					if (choice === "Skip") continue;
					const decision = choice === CLOSE ? "reap" : "keep";
					decisions[sig] = { decision, at: Date.now() };
					delete state.sightings[sig];
					log({ action: "decision", sig, decision });
				}
				saveDecisions(decisions);
				saveState(state, Date.now());
				void sweep(ctx);
				return;
			}

			if (sub === "decisions") {
				const decisions = loadDecisions();
				const sigs = Object.keys(decisions).sort();
				if (sigs.length === 0) {
					ctx.ui.notify("reaper: no decisions yet", "info");
					return;
				}
				const label = (sig: string) => `${decisions[sig].decision === "reap" ? "close" : "keep "}  ${sig}`;
				const picked = await ctx.ui.select("Change a decision", sigs.map(label));
				const sig = sigs.find(s => label(s) === picked);
				if (!sig) return;
				const action = await ctx.ui.select(sig, ["Switch to close", "Switch to keep", "Forget (ask again)"]);
				if (!action) return;
				if (action.startsWith("Forget")) delete decisions[sig];
				else decisions[sig] = { decision: action.endsWith("close") ? "reap" : "keep", at: Date.now() };
				saveDecisions(decisions);
				log({ action: "decision", sig, decision: decisions[sig]?.decision ?? "forget" });
				return;
			}

			const state = loadState();
			const lines = [
				`reaper${loadSettings().dryRun ? " (dry run)" : ""}: ${Object.keys(state.sightings).length} to review, ${Object.keys(loadDecisions()).length} decisions`,
				...[...tracked.values()].map(
					t => `  watching ${t.id} ${t.sig}: next ask in ${fmtAge(Math.max(0, t.nextCheck - Date.now()) / 1000)}${t.escalated ? " (agent did not answer)" : ""}`,
				),
				...readLog(8).map(e => `  ${String(e.ts).slice(5, 16)} ${e.action} ${e.sig ?? ""} ${e.id ?? ""}`),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

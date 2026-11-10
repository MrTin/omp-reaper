// Local state under <agent dir>/reaper/. Everything stays on this machine.
//
//   decisions.json  { "<signature>": { decision, at } }      learned close/keep answers, never pruned
//   state.json      { sightings, lastNotified }              lingering-but-undecided, pruned
//   leader.json     { pid, ts }                              which omp process sweeps orphans
//   reaper.log      JSONL of every action                    rotated at LOG_MAX_BYTES, 1 backup
//
// Tunables are omp plugin settings (`omp plugin config set omp-reaper <key> <value>`),
// declared once in package.json#omp.settings.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getPluginsLockfile } from "@oh-my-pi/pi-utils";
import pkg from "../package.json" with { type: "json" };
import type { Decision } from "./scan.ts";

const LOG_MAX_BYTES = 512 * 1024;
const SIGHTING_TTL_MS = 30 * 24 * 3600 * 1000;
const SIGHTING_MAX = 200;

export const dataDir = path.join(getAgentDir(), "reaper");
const file = (name: string) => path.join(dataDir, name);

export interface Settings {
	dryRun: boolean;
	graceMinutes: number;
	maxAsks: number;
	closeHeadlessBrowsers: boolean;
}

type SettingSchema = { type: "boolean" | "number"; default: boolean | number; env?: string };

/** `omp plugin config` value, else the declared env var, else the manifest default. */
export function loadSettings(lockfile = getPluginsLockfile()): Settings {
	let saved: Record<string, unknown> = {};
	try {
		saved = JSON.parse(fs.readFileSync(lockfile, "utf8")).settings?.[pkg.name] ?? {};
	} catch {
		// Not installed as a plugin (e.g. dropped into extensions/): defaults and env only.
	}
	const out: Record<string, unknown> = {};
	for (const [key, s] of Object.entries(pkg.omp.settings as Record<string, SettingSchema>)) {
		const raw = s.env ? process.env[s.env] : undefined;
		const fromEnv = raw === undefined ? undefined : s.type === "boolean" ? /^(1|true|yes|on)$/i.test(raw) : Number(raw);
		const value = saved[key] ?? fromEnv;
		out[key] = typeof value === typeof s.default && !Number.isNaN(value) ? value : s.default;
	}
	return out as unknown as Settings;
}

export interface DecisionRecord {
	decision: Decision;
	at: number;
}

export interface Sighting {
	firstSeen: number;
	lastSeen: number;
	/** Distinct instances seen (by pid or container id), not sweep count. */
	instances: number;
	recentIds: string[];
	example: string;
	maxRssKb: number;
}

export interface State {
	sightings: Record<string, Sighting>;
	lastNotified?: number;
}

function readJson<T>(name: string, fallback: T): T {
	try {
		return { ...fallback, ...JSON.parse(fs.readFileSync(file(name), "utf8")) };
	} catch {
		return fallback;
	}
}

function writeJson(name: string, value: unknown): void {
	fs.mkdirSync(dataDir, { recursive: true });
	// Atomic replace: several omp processes may write the same file.
	const tmp = `${file(name)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	fs.renameSync(tmp, file(name));
}

export const loadDecisions = (): Record<string, DecisionRecord> => readJson("decisions.json", {});
export const saveDecisions = (d: Record<string, DecisionRecord>) => writeJson("decisions.json", d);
export const loadState = (): State => readJson<State>("state.json", { sightings: {} });

export function saveState(state: State, now: number): void {
	const entries = Object.entries(state.sightings)
		.filter(([, s]) => now - s.lastSeen < SIGHTING_TTL_MS)
		.sort(([, a], [, b]) => b.lastSeen - a.lastSeen)
		.slice(0, SIGHTING_MAX);
	writeJson("state.json", { ...state, sightings: Object.fromEntries(entries) });
}

export function recordSighting(
	state: State,
	sig: string,
	id: string,
	example: string,
	rssKb: number,
	now: number,
): void {
	const s = state.sightings[sig] ?? {
		firstSeen: now,
		lastSeen: now,
		instances: 0,
		recentIds: [],
		example,
		maxRssKb: 0,
	};
	if (!s.recentIds.includes(id)) {
		s.instances++;
		s.recentIds = [id, ...s.recentIds].slice(0, 5);
		s.example = example;
	}
	s.lastSeen = now;
	s.maxRssKb = Math.max(s.maxRssKb, rssKb);
	state.sightings[sig] = s;
}

export function log(entry: Record<string, unknown>): void {
	try {
		fs.mkdirSync(dataDir, { recursive: true });
		const target = file("reaper.log");
		if ((fs.statSync(target, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES) {
			fs.renameSync(target, `${target}.1`);
		}
		fs.appendFileSync(target, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
	} catch {
		// Logging must never break a sweep.
	}
}

export function readLog(limit: number): Record<string, unknown>[] {
	try {
		return fs
			.readFileSync(file("reaper.log"), "utf8")
			.trim()
			.split("\n")
			.slice(-limit)
			.map(line => JSON.parse(line));
	} catch {
		return [];
	}
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * One omp process sweeps orphans at a time, so N open sessions do not kill,
 * log and record the same process N times.
 * ponytail: read-then-write lease, not a lock; two processes can both win one
 * tick. Kills are idempotent and the next tick settles it.
 */
export function tryLead(now: number, staleMs: number): boolean {
	const current = readJson<{ pid?: number; ts?: number }>("leader.json", {});
	const mine = current.pid === process.pid;
	const vacant = !current.pid || !current.ts || now - current.ts > staleMs || !alive(current.pid);
	if (!mine && !vacant) return false;
	writeJson("leader.json", { pid: process.pid, ts: now });
	return true;
}

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir, loadSettings, log, loadState, recordSighting, saveState, type State } from "../src/store.ts";

const DAY = 24 * 3600 * 1000;

describe("settings", () => {
	const lockfile = path.join(dataDir, "..", "omp-plugins.lock.json");
	const writeLock = (settings: Record<string, unknown>) => {
		fs.mkdirSync(path.dirname(lockfile), { recursive: true });
		fs.writeFileSync(lockfile, JSON.stringify({ settings: { "omp-reaper": settings } }));
	};
	afterEach(() => {
		fs.rmSync(lockfile, { force: true });
		delete process.env.OMP_REAPER_DRY_RUN;
		delete process.env.OMP_REAPER_GRACE_MINUTES;
	});

	test("manifest defaults when nothing is set", () => {
		expect(loadSettings(lockfile)).toEqual({
			dryRun: false,
			graceMinutes: 10,
			maxAsks: 2,
			closeHeadlessBrowsers: true,
		});
	});

	test("omp plugin config beats env, env beats default", () => {
		process.env.OMP_REAPER_DRY_RUN = "1";
		process.env.OMP_REAPER_GRACE_MINUTES = "3";
		writeLock({ graceMinutes: 30 });
		expect(loadSettings(lockfile)).toMatchObject({ dryRun: true, graceMinutes: 30 });
	});

	test("wrongly typed values fall back to the default", () => {
		writeLock({ maxAsks: "lots", dryRun: "yes" });
		process.env.OMP_REAPER_GRACE_MINUTES = "soon";
		expect(loadSettings(lockfile)).toMatchObject({ maxAsks: 2, dryRun: false, graceMinutes: 10 });
	});
});

describe("sightings", () => {
	test("count distinct instances, not sweeps", () => {
		const state: State = { sightings: {} };
		recordSighting(state, "node vite", "pid:1", "node vite", 100, 0);
		recordSighting(state, "node vite", "pid:1", "node vite", 300, 60_000);
		recordSighting(state, "node vite", "pid:2", "node vite", 200, 120_000);
		expect(state.sightings["node vite"]).toMatchObject({ instances: 2, maxRssKb: 300, lastSeen: 120_000 });
	});

	test("unseen for 30 days are dropped, the rest capped at 200 newest", () => {
		const now = 100 * DAY;
		const state: State = { sightings: {} };
		recordSighting(state, "stale", "pid:1", "stale", 0, now - 31 * DAY);
		for (let i = 0; i < 250; i++) recordSighting(state, `sig${i}`, `pid:${i}`, "x", 0, now - i * 1000);
		saveState(state, now);
		const kept = loadState().sightings;
		expect(Object.keys(kept)).toHaveLength(200);
		expect(kept.stale).toBeUndefined();
		expect(kept.sig0).toBeDefined();
		expect(kept.sig249).toBeUndefined();
	});
});

test("log rotates past 512 KB and keeps one backup", () => {
	const target = path.join(dataDir, "reaper.log");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(target, "x".repeat(600 * 1024));
	log({ action: "test" });
	expect(fs.statSync(`${target}.1`).size).toBe(600 * 1024);
	expect(fs.readFileSync(target, "utf8")).toContain('"action":"test"');
});

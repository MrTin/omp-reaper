// The OS boundary: process table, container list, omp session leases.
// Takes omp's `pi.exec` so tests can pass a plain spawn shim.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type Container, type Lease, type Proc, parseDockerPs, parseEnv, parsePs } from "./scan.ts";

export type Exec = ExtensionAPI["exec"];

const ompBin = path.basename(process.execPath).startsWith("omp") ? process.execPath : "omp";

/** Every process, with omp session markers filled in where readable. */
export async function listProcs(exec: Exec): Promise<Proc[]> {
	const base = await exec("ps", ["-axww", "-o", "pid=,ppid=,etime=,rss=,command="]);
	if (base.code !== 0) return [];
	const procs = parsePs(base.stdout);
	if (process.platform === "linux") {
		for (const p of procs) {
			try {
				Object.assign(p, parseEnv(fs.readFileSync(`/proc/${p.pid}/environ`, "utf8")));
			} catch {} // other users' processes, or already exited
		}
		return procs;
	}
	// BSD/macOS ps appends the initial environment after the command with -E.
	const withEnv = await exec("/bin/ps", ["-axwwE", "-o", "pid=,command="]);
	const byPid = new Map(procs.map(p => [p.pid, p]));
	for (const line of withEnv.stdout.split("\n")) {
		const m = line.match(/^\s*(\d+)\s(.*)$/);
		const p = m ? byPid.get(Number(m[1])) : undefined;
		if (p && m?.[2].startsWith(p.command)) Object.assign(p, parseEnv(m[2].slice(p.command.length)));
	}
	return procs;
}

export async function listContainers(exec: Exec, now: number): Promise<Container[]> {
	const format = '{{.ID}}\t{{.Label "omp.session"}}\t{{.Image}}\t{{.Names}}\t{{.CreatedAt}}';
	try {
		const res = await exec("docker", ["ps", "--filter", "label=omp.session", "--format", format], {
			timeout: 10_000,
		});
		return res.code === 0 ? parseDockerPs(res.stdout, now) : [];
	} catch {
		return []; // docker not installed
	}
}

/** `omp session lease` probes without claiming; anything it cannot answer stays "unknown". */
export async function queryLeases(exec: Exec, ids: string[]): Promise<Map<string, Lease>> {
	const leases = new Map<string, Lease>(ids.map(id => [id, "unknown"]));
	if (ids.length === 0) return leases;
	try {
		const res = await exec(ompBin, ["session", "lease", "--json", "--", ...ids], { timeout: 15_000 });
		if (res.code !== 0) return leases;
		const { held = [], unknown = [] } = JSON.parse(res.stdout) as { held?: string[]; unknown?: string[] };
		for (const id of ids) {
			leases.set(id, held.includes(id) ? "held" : unknown.includes(id) ? "unknown" : "free");
		}
	} catch {}
	return leases;
}

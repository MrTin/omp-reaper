// Integration: the real process table and, when installed, the real omp CLI.
import { afterAll, expect, test } from "bun:test";
import type { ExecResult } from "@oh-my-pi/pi-coding-agent";
import { detachedRoots, type Proc } from "../src/scan.ts";
import { listProcs, queryLeases } from "../src/system.ts";

const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
	const p = Bun.spawnSync([cmd, ...args]);
	return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), code: p.exitCode ?? 1, killed: false };
};

const marker = `omp-reaper-test-${process.pid}`;
const fakeSession = "00000000-0000-4000-8000-000000000000";

afterAll(() => {
	Bun.spawnSync(["pkill", "-f", marker]);
});

test("a detached process keeps its omp session marker and counts as detached", async () => {
	// Double fork so it is re-parented (launchd, init, or a Linux subreaper), as `cmd &` from the bash tool is.
	// Run bun itself: macOS hides the environment of SIP-protected binaries like /bin/sleep.
	const child = `${process.execPath} -e 'setTimeout(() => {}, 60000)' ${marker}`;
	Bun.spawnSync(["/bin/sh", "-c", `(PI_SESSION_ID=${fakeSession} PI_SESSION_FILE=/tmp/x.jsonl ${child} &)`]);

	// The detached child is outside our control: poll the real process table until it shows up.
	let procs: Proc[] = [];
	let proc: Proc | undefined;
	for (let i = 0; i < 60 && !proc?.sessionId; i++) {
		procs = await listProcs(exec);
		proc = procs.find(p => p.command.includes(marker));
		if (!proc?.sessionId) await Bun.sleep(50);
	}
	if (!proc?.sessionId) {
		// Diagnostics for CI: what the process table actually shows for the child.
		const ps = await exec("ps", ["-axww", "-o", "pid=,ppid=,command="]);
		console.log("found:", proc, "ps:", ps.stdout.split("\n").filter(l => l.includes(marker)));
	}
	expect(proc).toMatchObject({ sessionId: fakeSession, sessionFile: "/tmp/x.jsonl" });
	expect(detachedRoots(procs, process.pid).map(p => p.pid)).toContain(proc?.pid ?? -1);
}, 15_000);

test.skipIf(!Bun.which("omp"))("omp reports an unknown session as free", async () => {
	const leases = await queryLeases(exec, [fakeSession]);
	expect(leases.get(fakeSession)).toBe("free");
});

import { describe, expect, test } from "bun:test";
import {
	type ClassifyContext,
	type ClassifyInput,
	classify,
	containerSignature,
	descendants,
	detachedRoots,
	parseDockerPs,
	parseEnv,
	parseEtime,
	parsePs,
	redact,
	signature,
} from "../src/scan.ts";

const HOME = "/Users/someone";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function ctx(over: Partial<ClassifyContext> & { leases?: Record<string, "held" | "free" | "unknown"> } = {}) {
	const { leases = {}, ...rest } = over;
	const base: ClassifyContext = {
		home: HOME,
		mySessionId: "me",
		mySessionFile: "/s/2026_me.jsonl",
		minAgeSec: 120,
		closeBrowsers: true,
		lease: id => leases[id] ?? "unknown",
		decision: () => undefined,
	};
	return Object.assign(base, rest);
}

const item = (command: string, over: Partial<ClassifyInput> = {}): ClassifyInput => ({
	command,
	sig: signature(command),
	ageSec: 3600,
	...over,
});

describe("parsing", () => {
	test("etime forms", () => {
		expect(parseEtime("05")).toBe(5);
		expect(parseEtime("01:05")).toBe(65);
		expect(parseEtime("02:01:05")).toBe(7265);
		expect(parseEtime("3-02:01:05")).toBe(3 * 86400 + 7265);
	});

	test("ps rows keep commands with spaces", () => {
		const [p] = parsePs(`41172     1 4-00:45:45  97568 ${CHROME} --headless=new\n`);
		expect(p).toMatchObject({ pid: 41172, ppid: 1, rssKb: 97568, command: `${CHROME} --headless=new` });
	});

	test("session markers from env, path with spaces", () => {
		const env = " TERM=xterm PI_SESSION_ID=abc-1 PI_SESSION_FILE=/Users/x/My Sessions/a.jsonl PI_TOOL_CALL_ID=t1";
		expect(parseEnv(env)).toEqual({ sessionId: "abc-1", sessionFile: "/Users/x/My Sessions/a.jsonl" });
		expect(parseEnv("PATH=/bin\0PI_SESSION_ID=z\0")).toEqual({ sessionId: "z", sessionFile: undefined });
	});

	test("docker rows", () => {
		const now = Date.parse("2026-11-10T14:10:00+01:00");
		const [c] = parseDockerPs("abc\tsess\tredis:7\tcache\t2026-11-10 14:00:00 +0100 CET", now);
		expect(c).toEqual({ id: "abc", sessionId: "sess", image: "redis:7", name: "cache", ageSec: 600 });
	});

	test("descendants walks the whole tree", () => {
		const procs = parsePs("10 1 1:00 1 a\n11 10 1:00 1 b\n12 11 1:00 1 c\n13 1 1:00 1 d\n");
		expect(descendants(procs, 10).sort()).toEqual([11, 12]);
	});

	test("detached roots: re-parented to init or a subreaper, never under omp", () => {
		const procs = parsePs(
			[
				"1 0 9:00 1 /sbin/init",
				"50 1 9:00 1 /usr/lib/systemd/systemd --user",
				"100 1 9:00 1 /Users/x/.bun/bin/omp",
				"101 100 9:00 1 node tracked-job.js",
				"200 50 9:00 1 node orphan-under-subreaper.js",
				"201 200 9:00 1 node its-child.js",
				"300 1 9:00 1 node orphan-under-init.js",
				"400 1 9:00 1 some-daemon",
			].join("\n"),
		);
		for (const p of procs) if ([101, 200, 201, 300].includes(p.pid)) p.sessionId = "s";
		// 50 and 400 have no marker: candidates only for the throwaway-browser rule in classify.
		expect(detachedRoots(procs, 999).map(p => p.pid)).toEqual([50, 200, 300, 400]);
	});
});

describe("signature", () => {
	test.each([
		["node /x/node_modules/.bin/vite --port 5173", "node vite"],
		["python3 -m http.server 8000", "python3 -m http.server"],
		["bun run dev", "bun run dev"],
		[`${CHROME} --headless=new --user-data-dir=/tmp/p-1731234567`, "Google Chrome --headless"],
		["python3 -u /var/folders/ab/T/omp-python-3f9a1c2b7d.py", "python3 omp-python-*.py"],
		["python3 -c import time; time.sleep(900)", "python3 -c"],
	])("%s", (command, expected) => expect(signature(command)).toBe(expected));

	test("containers drop the tag", () => {
		expect(containerSignature("postgres:16-alpine")).toBe("docker:postgres");
		expect(containerSignature("localhost:5000/app:1.2")).toBe("docker:localhost:5000/app");
	});
});

describe("classify", () => {
	const tmpChrome = `${CHROME} --headless=new --user-data-dir=/tmp/x`;

	test("too young is left alone", () => {
		expect(classify(item(tmpChrome, { ageSec: 30 }), ctx()).kind).toBe("ignore");
	});

	test("headless browser without a session marker: reaped only with a throwaway profile", () => {
		expect(classify(item(tmpChrome), ctx()).kind).toBe("reap");
		expect(classify(item(`${CHROME} --headless=new --user-data-dir=${HOME}/.omp/browser-profiles/g-1`), ctx()).kind).toBe("reap");
		expect(classify(item(`${CHROME} --headless=new --user-data-dir=${HOME}/chrome-dev`), ctx()).kind).toBe("ignore");
		expect(classify(item("node server.js"), ctx()).kind).toBe("ignore");
	});

	test("owner session ended", () => {
		const c = ctx({ leases: { dead: "free" } });
		expect(classify(item("node server.js", { sessionId: "dead" }), c).kind).toBe("record");
		expect(classify(item(tmpChrome, { sessionId: "dead" }), c).kind).toBe("reap");
		const decided = (d: "reap" | "keep") => ctx({ leases: { dead: "free" }, decision: () => d });
		expect(classify(item("node server.js", { sessionId: "dead" }), decided("reap")).kind).toBe("reap");
		expect(classify(item(tmpChrome, { sessionId: "dead" }), decided("keep")).kind).toBe("keep");
	});

	test("owner session live: mine (incl. subagents) vs someone else's", () => {
		const c = ctx({ leases: { me: "held", sub: "held", other: "held" } });
		expect(classify(item("node server.js", { sessionId: "me" }), c).kind).toBe("mine");
		expect(
			classify(item("node server.js", { sessionId: "sub", sessionFile: "/s/2026_me/Explore.jsonl" }), c).kind,
		).toBe("mine");
		expect(
			classify(item("node server.js", { sessionId: "other", sessionFile: "/s/2026_other.jsonl" }), c).kind,
		).toBe("ignore");
	});

	test("unknown lease never kills", () => {
		expect(classify(item(tmpChrome, { sessionId: "x" }), ctx({ leases: { x: "unknown" } })).kind).toBe("ignore");
	});

	test("closeHeadlessBrowsers off: browsers are asked about like anything else", () => {
		const c = ctx({ closeBrowsers: false, leases: { dead: "free" } });
		expect(classify(item(tmpChrome), c).kind).toBe("ignore");
		expect(classify(item(tmpChrome, { sessionId: "dead" }), c).kind).toBe("record");
	});
});

test("redact strips credentials", () => {
	expect(redact("app --token=abc123 --api-key xyz https://user:pw@host/x")).toBe(
		"app --token=*** --api-key *** https://***@host/x",
	);
	expect(redact("curl -H auth: secret")).toBe("curl -H auth: ***");
});

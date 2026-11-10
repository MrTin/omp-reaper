// Pure helpers: parse process/container listings, derive a stable signature per
// kind of process, and decide what to do with each one. No I/O here, so the
// decision table is unit-testable (see test/scan.test.ts).

export interface Proc {
	pid: number;
	ppid: number;
	ageSec: number;
	rssKb: number;
	command: string;
	/** `PI_SESSION_ID` inherited from the omp bash tool, if any. */
	sessionId?: string;
	/** `PI_SESSION_FILE` inherited from the omp bash tool, if any. */
	sessionFile?: string;
}

export interface Container {
	id: string;
	name: string;
	image: string;
	ageSec: number;
	/** Value of the `omp.session` label. */
	sessionId: string;
}

export type Lease = "held" | "free" | "unknown";
export type Decision = "reap" | "keep";

export type Verdict =
	| { kind: "reap"; reason: string }
	| { kind: "record" }
	| { kind: "keep" }
	| { kind: "mine" }
	| { kind: "ignore" };

/** `[[dd-]hh:]mm:ss` (BSD/procps `etime`) to seconds. */
export function parseEtime(etime: string): number {
	const [days, rest] = etime.includes("-") ? etime.split("-", 2) : ["0", etime];
	const parts = rest.split(":").map(Number);
	while (parts.length < 3) parts.unshift(0);
	const [h, m, s] = parts;
	return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

/** Parse `ps -o pid=,ppid=,etime=,rss=,command=` output. */
export function parsePs(out: string): Proc[] {
	const procs: Proc[] = [];
	for (const line of out.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
		if (!m) continue;
		procs.push({
			pid: Number(m[1]),
			ppid: Number(m[2]),
			ageSec: parseEtime(m[3]),
			rssKb: Number(m[4]),
			command: m[5],
		});
	}
	return procs;
}

/** Extract the omp session markers from an environment string (space- or NUL-separated). */
export function parseEnv(env: string): { sessionId?: string; sessionFile?: string } {
	const text = env.replaceAll("\0", " ");
	const id = text.match(/(?:^|\s)PI_SESSION_ID=(\S+)/)?.[1];
	// Paths may contain spaces: stop at the next `NAME=` token.
	const file = text.match(/(?:^|\s)PI_SESSION_FILE=(.+?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/)?.[1];
	return { sessionId: id, sessionFile: file?.trim() };
}

/** Parse `docker ps --format '{{.ID}}\t{{.Label "omp.session"}}\t{{.Image}}\t{{.Names}}\t{{.CreatedAt}}'`. */
export function parseDockerPs(out: string, now: number): Container[] {
	const containers: Container[] = [];
	for (const line of out.split("\n")) {
		const [id, sessionId, image, name, createdAt] = line.split("\t");
		if (!id || !sessionId || !image) continue;
		// "2026-11-10 14:00:00 +0100 CET" -> ISO
		const m = createdAt?.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)/);
		const created = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : Number.NaN;
		const ageSec = Number.isNaN(created) ? 0 : Math.max(0, Math.round((now - created) / 1000));
		containers.push({ id, sessionId, image, name: name ?? "", ageSec });
	}
	return containers;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
// Random temp names (hashes, pids, timestamps) would make every instance unique.
const normalize = (token: string) => token.replace(/[0-9a-f]{6,}|\d{3,}/gi, "*");

/**
 * A stable label for "this kind of process", used as the key for learned
 * decisions: executable plus up to two positional arguments.
 * `node /x/node_modules/.bin/vite --port 5173` -> `node vite`.
 */
export function signature(command: string): string {
	let exe: string;
	let rest: string;
	const app = command.match(/\.app\/Contents\/MacOS\/(.+?)(?=\s-|$)/);
	if (app) {
		exe = app[1];
		rest = command.slice((app.index ?? 0) + app[0].length);
	} else {
		const [first = "", ...others] = command.trim().split(/\s+/);
		exe = basename(first);
		rest = others.join(" ");
	}
	const tokens = rest.trim().split(/\s+/).filter(Boolean);
	const args: string[] = [];
	for (let i = 0; i < tokens.length && args.length < 2; i++) {
		const t = tokens[i];
		if (t === "-m" && tokens[i + 1]) {
			args.push(`-m ${tokens[++i]}`);
			continue;
		}
		// Inline code (`python -c '…'`, `node -e '…'`) is not a stable name.
		if (t === "-c" || t === "-e" || t === "--eval") {
			args.push(t);
			break;
		}
		if (t.startsWith("-") || t.includes("=") || /^\d+$/.test(t)) continue;
		args.push(normalize(basename(t)));
	}
	if (isHeadlessBrowser(command)) args.push("--headless");
	return [normalize(exe), ...args].join(" ");
}

export function containerSignature(image: string): string {
	return `docker:${image.replace(/(:[^/:]+|@sha256:[0-9a-f]+)$/, "")}`;
}

export function isHeadlessBrowser(command: string): boolean {
	return /chrom|chrome-headless-shell|msedge|brave/i.test(command) && /--headless\b/.test(command);
}

/** A browser profile in a throwaway location: nobody keeps state there on purpose. */
export function hasThrowawayProfile(command: string, home: string): boolean {
	const dir = command.match(/--user-data-dir=(\S+)/)?.[1];
	if (!dir) return false;
	return (
		/^\/(private\/)?(tmp|var\/folders)\//.test(dir) || dir.startsWith(`${home}/.omp/browser-profiles/`)
	);
}

/** omp's own processes manage their own lifecycle; never touch them. */
export function isOmpProcess(command: string): boolean {
	const exe = basename(command.trim().split(/\s+/)[0] ?? "");
	return exe === "omp" || command.includes("__omp_worker");
}

/** Processes re-parented to launchd/init: their launching shell or omp is gone. */
export function detachedRoots(procs: Proc[], selfPid: number): Proc[] {
	return procs.filter(p => p.ppid === 1 && p.pid !== selfPid && !isOmpProcess(p.command));
}

export function descendants(procs: Proc[], rootPid: number): number[] {
	const children = new Map<number, number[]>();
	for (const p of procs) {
		const list = children.get(p.ppid) ?? [];
		list.push(p.pid);
		children.set(p.ppid, list);
	}
	const out: number[] = [];
	const stack = [...(children.get(rootPid) ?? [])];
	while (stack.length > 0) {
		const pid = stack.pop() as number;
		out.push(pid);
		stack.push(...(children.get(pid) ?? []));
	}
	return out;
}

export interface ClassifyInput {
	command: string;
	sig: string;
	ageSec: number;
	sessionId?: string;
	sessionFile?: string;
}

export interface ClassifyContext {
	home: string;
	mySessionId?: string;
	mySessionFile?: string;
	minAgeSec: number;
	/** Close abandoned headless browsers without asking (setting `closeHeadlessBrowsers`). */
	closeBrowsers: boolean;
	lease(sessionId: string): Lease;
	decision(sig: string): Decision | undefined;
}

/** A subagent's session file lives in a directory named after its parent's session file. */
export function ownedBy(item: ClassifyInput, sessionId?: string, sessionFile?: string): boolean {
	if (!item.sessionId) return false;
	if (sessionId && item.sessionId === sessionId) return true;
	if (!sessionFile || !item.sessionFile) return false;
	return item.sessionFile.startsWith(`${sessionFile.replace(/\.jsonl$/, "")}/`);
}

export function classify(item: ClassifyInput, ctx: ClassifyContext): Verdict {
	if (item.ageSec < ctx.minAgeSec) return { kind: "ignore" };
	const decision = ctx.decision(item.sig);
	const browser = ctx.closeBrowsers && isHeadlessBrowser(item.command);

	if (!item.sessionId) {
		// No session marker: only an omp-style throwaway headless browser is ours to judge.
		if (!browser || !hasThrowawayProfile(item.command, ctx.home)) return { kind: "ignore" };
		if (decision === "keep") return { kind: "keep" };
		return { kind: "reap", reason: "headless browser whose launcher exited" };
	}

	const lease = ctx.lease(item.sessionId);
	if (lease === "unknown") return { kind: "ignore" };
	if (lease === "held") {
		if (!ownedBy(item, ctx.mySessionId, ctx.mySessionFile)) return { kind: "ignore" };
		return decision === "keep" ? { kind: "keep" } : { kind: "mine" };
	}

	if (decision === "keep") return { kind: "keep" };
	if (decision === "reap") return { kind: "reap", reason: "owner session ended; decided: close" };
	if (browser) return { kind: "reap", reason: "owner session ended; headless browser" };
	return { kind: "record" };
}

/** Strip obvious credentials before a command line is written to disk or shown. */
export function redact(command: string): string {
	return command
		.replace(/((?:token|secret|passw(?:or)?d|pass|api[-_]?key|auth)[\w-]*(?:[=:]\s*|\s+(?=[^-\s])))\S+/gi, "$1***")
		.replace(/(\/\/)[^/@\s]+@/g, "$1***@")
		.slice(0, 200);
}

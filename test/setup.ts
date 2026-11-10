// Preloaded by bunfig.toml: point the agent dir at a throwaway directory before
// src/store.ts resolves it, so tests never touch ~/.omp.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omp-reaper-test-"));

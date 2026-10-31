import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readLiveMetamonLaunch } from "../../apps/companion/src/battle-agent/liveMetamon.ts";

test("live MLX launch parses through the production companion reader", async () => {
  const file = fileURLToPath(new URL("../../config/local/metamon-live.json", import.meta.url));
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const launch = await readLiveMetamonLaunch(file);
  assert.deepEqual(launch, { command: raw.command, args: raw.args, maxWorkers: raw.maxWorkers });
  assert.ok(raw.command.endsWith("/tmp/metamon-port/.venv/bin/python"));
  assert.equal(raw.args[raw.args.indexOf("--seed") + 1], "{seed}");
  assert.ok(raw.args.includes("--seed-per-side"));
  assert.ok(raw.args.some((arg: string) => arg.endsWith("/scripts/metamon_port/mlx_worker.py")));
  assert.ok(![raw.command, ...raw.args].some((arg: string) => /\bssh\b/.test(arg)));
  // The UU lead model (lead_model.py): a project-relative checkpoint whose bytes match the wrapper's pinned SHA256.
  const lead = raw.args[raw.args.indexOf("--lead-checkpoint") + 1];
  assert.ok(raw.args.includes("--lead-checkpoint") && lead && !lead.startsWith("/"), "lead checkpoint configured, project-relative");
  const pinned = /^SHA256 = "([a-f0-9]{64})"$/m.exec(await fs.readFile(new URL("./lead_model.py", import.meta.url), "utf8"))?.[1];
  assert.equal(createHash("sha256").update(await fs.readFile(new URL(`../../${lead}`, import.meta.url))).digest("hex"), pinned);
  const worker = await fs.readFile(new URL("../metamon-worker.py", import.meta.url));
  assert.equal(createHash("sha256").update(worker).digest("hex"), raw.workerSha256);
});

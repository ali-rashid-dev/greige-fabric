import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const rebuildCli = path.join(root, "node_modules", "@electron", "rebuild", "lib", "cli.js");
const vitestCli = path.join(root, "node_modules", "vitest", "vitest.mjs");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

let testStatus = run(npm, ["rebuild", "better-sqlite3"]);
if (testStatus === 0) {
  testStatus = run(process.execPath, [vitestCli, "run"]);
}

const electronRebuildStatus = run(process.execPath, [
  rebuildCli,
  "-f",
  "-w",
  "better-sqlite3",
]);

process.exitCode = testStatus || electronRebuildStatus;

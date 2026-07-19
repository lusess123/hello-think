import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeLocalDevVars } from "./remove-local-dev-vars.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = path.join(projectRoot, "node_modules/vite/bin/vite.js");
const buildEnvironment = { ...process.env };

// A production bundle needs binding names, never local secret values. Prevent
// Wrangler/Vite from loading dotenv or inheriting these process secrets at the
// source, then also clean in `finally` for interrupted/failed prior builds.
for (const name of [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "AI_GATEWAY_BASE_URL",
  "AI_GATEWAY_TOKEN",
  "STORY_GITHUB_PRIVATE_KEY",
  "CLOUDFLARE_INCLUDE_PROCESS_ENV"
]) {
  delete buildEnvironment[name];
}
buildEnvironment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";

await removeLocalDevVars();
let exitCode = 1;
try {
  exitCode = await runViteBuild();
} finally {
  await removeLocalDevVars();
}

if (exitCode !== 0) process.exit(exitCode);

function runViteBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [viteBin, "build", ...process.argv.slice(2)],
      {
        cwd: projectRoot,
        env: buildEnvironment,
        stdio: "inherit"
      }
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Vite build terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

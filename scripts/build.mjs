import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareApiDeployConfig } from "./prepare-api-deploy-config.mjs";
import { removeLocalDevVars } from "./remove-local-dev-vars.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = path.join(projectRoot, "node_modules/vite/bin/vite.js");
const buildEnvironment = { ...process.env };
const publicApiOrigin = buildEnvironment.VITE_API_ORIGIN?.trim();

if (buildEnvironment.CI && !publicApiOrigin) {
  throw new Error("CI production builds require VITE_API_ORIGIN");
}
if (publicApiOrigin && new URL(publicApiOrigin).origin !== publicApiOrigin) {
  throw new Error("VITE_API_ORIGIN must be an exact origin without a path");
}

// A production bundle needs binding names, never local secret values. Prevent
// Wrangler/Vite from loading dotenv or inheriting these process secrets at the
// source, then also clean in `finally` for interrupted/failed prior builds.
for (const name of [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "AI_GATEWAY_BASE_URL",
  "AI_GATEWAY_TOKEN",
  "STORY_GITHUB_PRIVATE_KEY",
  "WS_TOKEN_SECRET",
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

await prepareApiDeployConfig(projectRoot);
if (publicApiOrigin) {
  await assertClientBundleContainsApiOrigin(projectRoot, publicApiOrigin);
}

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

async function assertClientBundleContainsApiOrigin(root, expectedOrigin) {
  const assetsDirectory = path.join(root, "dist", "client", "assets");
  const assetNames = await readdir(assetsDirectory);
  for (const name of assetNames) {
    if (!name.endsWith(".js")) continue;
    const content = await readFile(path.join(assetsDirectory, name), "utf8");
    if (content.includes(expectedOrigin)) {
      console.log(`Verified frontend API origin: ${expectedOrigin}`);
      return;
    }
  }
  throw new Error(`Frontend bundle is missing VITE_API_ORIGIN ${expectedOrigin}`);
}

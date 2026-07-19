import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateKeyPath = path.resolve(
  projectRoot,
  process.env.STORY_GITHUB_PRIVATE_KEY_PATH ??
    ".ai-doc/gihtub/dsl-chat.2026-07-18.private-key.pem"
);

try {
  await access(privateKeyPath, constants.R_OK);
} catch {
  console.error(
    `GitHub App private key is not readable: ${privateKeyPath}\n` +
      "Set STORY_GITHUB_PRIVATE_KEY_PATH when using a different key file."
  );
  process.exit(1);
}

const privateKey = await readFile(privateKeyPath, "utf8");
if (!privateKey.includes("BEGIN RSA PRIVATE KEY")) {
  console.error(`Unsupported GitHub App private key format: ${privateKeyPath}`);
  process.exit(1);
}

const viteBin = path.join(projectRoot, "node_modules/vite/bin/vite.js");
const childEnvironment = { ...process.env };
delete childEnvironment.CLOUDFLARE_INCLUDE_PROCESS_ENV;
const child = spawn(process.execPath, [viteBin, "dev", ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: {
    ...childEnvironment,
    // `wrangler.jsonc#secrets.required` is the allowlist that decides which
    // process variables enter the Worker. Never enable the legacy all-env
    // forwarding flag here: shells often contain unrelated credentials.
    STORY_GITHUB_PRIVATE_KEY: privateKey
  },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

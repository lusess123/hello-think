import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

// Cloudflare's Vite plugin copies local dev bindings beside generated Worker
// code for local preview. They are not needed for deployment, so remove every
// exact `.dev.vars` file under the disposable build directory before another
// command can archive or upload the artifact.
export async function removeLocalDevVars(
  buildRoot = path.join(projectRoot, "dist")
) {
  await removeDevVars(buildRoot);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await removeLocalDevVars();
}

async function removeDevVars(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await removeDevVars(target);
      } else if (entry.isFile() && entry.name === ".dev.vars") {
        await unlink(target);
      }
    })
  );
}

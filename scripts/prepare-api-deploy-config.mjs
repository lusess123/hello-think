import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_WORKER_NAME = "hello-think";
const API_CUSTOM_DOMAIN = "dsl-api.zyking.xyz";
const API_ORIGIN = `https://${API_CUSTOM_DOMAIN}`;
const FRONTEND_ORIGIN = "https://dsl.zyking.xyz";
const GENERATED_WORKER_DIRECTORY = "hello_think";

export async function prepareApiDeployConfig(projectRoot) {
  const workerDirectory = path.join(
    projectRoot,
    "dist",
    GENERATED_WORKER_DIRECTORY
  );
  const generatedConfigPath = path.join(workerDirectory, "wrangler.json");
  const apiConfigPath = path.join(workerDirectory, "wrangler.api.json");
  const generatedConfig = JSON.parse(
    await readFile(generatedConfigPath, "utf8")
  );

  if (generatedConfig.name !== API_WORKER_NAME) {
    throw new Error(
      `Expected generated API Worker name ${API_WORKER_NAME}, got ${String(generatedConfig.name)}`
    );
  }
  if (typeof generatedConfig.main !== "string" || !generatedConfig.main) {
    throw new Error("Generated API Worker config is missing its main entry");
  }
  if (!generatedConfig.assets) {
    throw new Error(
      "Generated API Worker config did not contain client assets to remove"
    );
  }
  if (
    !Array.isArray(generatedConfig.routes) ||
    !generatedConfig.routes.some(
      (route) =>
        route?.pattern === API_CUSTOM_DOMAIN && route.custom_domain === true
    )
  ) {
    throw new Error(
      `Generated API Worker config is missing custom domain ${API_CUSTOM_DOMAIN}`
    );
  }
  if (generatedConfig.vars?.API_ORIGIN !== API_ORIGIN) {
    throw new Error(
      `Generated API Worker config must set API_ORIGIN to ${API_ORIGIN}`
    );
  }
  if (generatedConfig.vars?.FRONTEND_ORIGIN !== FRONTEND_ORIGIN) {
    throw new Error(
      `Generated API Worker config must set FRONTEND_ORIGIN to ${FRONTEND_ORIGIN}`
    );
  }

  delete generatedConfig.assets;
  if ("assets" in generatedConfig) {
    throw new Error("Failed to remove assets from generated API Worker config");
  }
  await writeFile(
    apiConfigPath,
    `${JSON.stringify(generatedConfig, null, 2)}\n`,
    "utf8"
  );
  console.log(`Prepared assets-free API Worker config: ${apiConfigPath}`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const projectRoot = path.resolve(path.dirname(scriptPath), "..");
  await prepareApiDeployConfig(projectRoot);
}

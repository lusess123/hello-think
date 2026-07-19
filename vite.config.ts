import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { think } from "@cloudflare/think/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    fs: {
      // Keep Vite's default credential denylist and protect the entire
      // repository-local work-item folder. `.gitignore` does not affect what
      // the dev server can serve by URL.
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.ai-doc/**"]
    }
  },
  plugins: [
    think({ allowNonVirtualMain: true }),
    react(),
    // Keep the integrated local dev server, but make the API Worker config
    // explicit. Production deploys its generated Worker bundle and the client
    // assets as two independent Workers.
    cloudflare({ configPath: "./wrangler.jsonc" }),
    tailwindcss()
  ]
});

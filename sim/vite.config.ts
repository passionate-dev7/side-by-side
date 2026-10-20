import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { llmMiddleware } from "./server/llm";

const llm: Plugin = {
  name: "llm-proxy",
  configureServer: (s) => void s.middlewares.use(llmMiddleware),
  configurePreviewServer: (s) => void s.middlewares.use(llmMiddleware),
};

export default defineConfig({ plugins: [react(), llm], server: { host: "127.0.0.1", port: 5173 } });

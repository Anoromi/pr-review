import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    // The same defaults as server/port.ts.
    port: Number(process.env.PORT) || 4318,
    strictPort: true,
    proxy: { "/trpc": `http://127.0.0.1:${Number(process.env.API_PORT) || 4319}` },
  },
});

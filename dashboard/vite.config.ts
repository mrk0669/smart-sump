import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// During development (`npm run dev`) the dashboard runs on :5173 and forwards
// /api calls to the logger on :8000, so the browser sees one origin.
// In production the logger (or nginx in Docker) serves both.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
});

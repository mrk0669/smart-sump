import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Two builds from the same code:
//  - normal (`npm run build`): the live dashboard, served by the logger/nginx.
//    During development (`npm run dev`) /api is forwarded to the logger on :8000.
//  - apk (`npm run build:apk`): the phone app with the virtual sump built in
//    (.env.apk sets VITE_VIRTUAL=1). Everything is packed into ONE index.html
//    inside the Android project, because the app opens it straight from the
//    APK's files with no web server.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === "apk" ? [viteSingleFile()] : [])],
  base: mode === "apk" ? "./" : "/",
  build: mode === "apk" ? { outDir: "../android/app/src/main/assets", emptyOutDir: true } : undefined,
  server: {
    port: mode === "apk" ? 5174 : 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
}));

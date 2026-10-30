import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // FH: a proxy to :3000 would avoid the CORS/cookie dance, claude suggested it
  server: {
    port: 5173,
    // The API sends no CORS headers, so the browser blocks every call from
    // :5173 to :3000. Proxy /v1 so the dashboard and API share an origin in
    // dev (.env.development points the client at relative URLs).
    proxy: { "/v1": "http://localhost:3000" },
  },
});

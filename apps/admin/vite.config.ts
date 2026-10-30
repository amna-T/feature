import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // apps/web already owns 5173.
    // 5174 clashes with storybook on my machine — am
    port: 5174,
    // Same reason as apps/web: the API has no CORS, so proxy /v1 in dev.
    proxy: { "/v1": "http://localhost:3000" },
  },
});

import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "./",
  server: {
    port: 5180,
    strictPort: true,
    open: false,
  },
});

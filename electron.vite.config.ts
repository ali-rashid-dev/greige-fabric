import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@main": resolve("src/main"),
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      outDir: "dist-electron",
      rollupOptions: {
        input: resolve("src/main/index.ts"),
        output: { entryFileNames: "main.js" },
      },
    },
  },
});

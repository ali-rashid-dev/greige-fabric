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
  preload: {
    build: {
      outDir: "dist-electron",
      emptyOutDir: false,
      isolatedEntries: true,
      externalizeDeps: false,
      rollupOptions: {
        input: resolve("src/main/preload.ts"),
        output: { entryFileNames: "preload.js", format: "cjs" },
      },
    },
  },
});

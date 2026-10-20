import { defineConfig, loadEnv } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { resolve } from "path";
import AdmZip from "adm-zip";

// npm run dev / build：输出到 SIYUAN_PLUGIN_DIR（环境变量或未提交的 .env.local），未设置时输出到 dist/
// npm run package：始终清空并输出到 dist/，再把 dist/ 打包成 package.zip
export default defineConfig(({ mode }) => {
const isPackage = mode === "package";
const pluginDir = loadEnv(mode, __dirname, "SIYUAN_").SIYUAN_PLUGIN_DIR;
const outDir = isPackage ? "dist" : (pluginDir || "dist");
return {
  build: {
    outDir,
    emptyOutDir: isPackage,
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["siyuan", "process"],
      output: {
        entryFileNames: "index.js",
        assetFileNames: "index.css",
      },
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: "plugin.json", dest: "./" },
        { src: "README*.md", dest: "./" },
        { src: "icon.png", dest: "./" },
        { src: "i18n", dest: "./" },
      ],
    }),
    {
      name: "package-zip",
      apply: "build",
      closeBundle() {
        if (!isPackage) return;
        const zip = new AdmZip();
        zip.addLocalFolder(resolve(__dirname, "dist"));
        zip.writeZip(resolve(__dirname, "package.zip"));
        console.log("package.zip created");
      },
    },
  ],
};
});

import { mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, "..");
const distDir = path.join(frontendDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

for (const filename of ["index.html", "main.js", "style.css"]) {
  await copyFile(path.join(frontendDir, filename), path.join(distDir, filename));
}

const apiBase = String(process.env.FRONTEND_API_BASE_URL || "").trim();
const configContent =
  "window.AI_STUDY_CONFIG = Object.assign({}, window.AI_STUDY_CONFIG, " +
  JSON.stringify({ API_BASE: apiBase }, null, 2) +
  ");\n";

await writeFile(path.join(distDir, "config.js"), configContent, "utf8");

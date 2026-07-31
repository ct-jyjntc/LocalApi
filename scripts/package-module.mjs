#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AdmZip = require("../server/node_modules/adm-zip");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const moduleId = process.argv[2] || "linuxdo";
const moduleSrc = path.join(root, "modules", moduleId);
const manifestPath = path.join(moduleSrc, "module.json");

if (!fs.existsSync(manifestPath)) {
  console.error(`Module not found: ${moduleSrc}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
console.log(`Packaging module ${manifest.id}@${manifest.version}`);

// 1) Compile TypeScript with the server toolchain
const tscBin = path.join(root, "server", "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tscBin)) {
  console.error("TypeScript not found under server/node_modules. Run npm install --prefix server.");
  process.exit(1);
}
execFileSync(process.execPath, [tscBin, "-p", moduleSrc], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

const distDir = path.join(moduleSrc, "dist");
if (!fs.existsSync(distDir)) {
  console.error("tsc did not produce dist/");
  process.exit(1);
}

// 2) Stage module.json + dist files flat for the zip / bundled copy
const stageDir = path.join(moduleSrc, ".stage");
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
fs.copyFileSync(manifestPath, path.join(stageDir, "module.json"));

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}
copyRecursive(distDir, stageDir);

// 3) Zip to artifacts/
const artifactsDir = path.join(root, "artifacts");
fs.mkdirSync(artifactsDir, { recursive: true });
const zipPath = path.join(artifactsDir, `${moduleId}.zip`);
const zip = new AdmZip();
function addDir(dir, prefix = "") {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) addDir(full, rel);
    else zip.addLocalFile(full, prefix || undefined, name);
  }
}
addDir(stageDir);
zip.writeZip(zipPath);
console.log(`Wrote ${zipPath}`);

// 4) Copy to server/bundled-modules/{id}
const bundledDir = path.join(root, "server", "bundled-modules", moduleId);
fs.rmSync(bundledDir, { recursive: true, force: true });
copyRecursive(stageDir, bundledDir);
console.log(`Copied bundled module to ${bundledDir}`);

// Cleanup stage
fs.rmSync(stageDir, { recursive: true, force: true });
console.log("Done.");

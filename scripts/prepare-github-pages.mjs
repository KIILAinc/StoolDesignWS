import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("dist/client");
const textExtensions = new Set([".html", ".js", ".css", ".rsc", ".json", ".txt"]);

async function rewriteDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteDirectory(filePath);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name))) continue;

    const original = await readFile(filePath, "utf8");
    const relative = original.replaceAll("/_next/", "./_next/").replaceAll("/chairs/", "./chairs/");
    if (relative !== original) await writeFile(filePath, relative);
  }
}

await rewriteDirectory(root);
console.log(`Prepared ${root} for GitHub Pages subpath hosting.`);

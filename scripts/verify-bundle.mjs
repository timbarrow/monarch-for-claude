import { readFile } from "node:fs/promises";
import yauzl from "yauzl";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const bundle = `dist/monarch-for-claude-${manifest.version}.mcpb`;
const entries = await new Promise((resolve, reject) =>
  yauzl.open(bundle, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) return reject(error ?? new Error("Cannot open bundle"));
    const names = [];
    zip.readEntry();
    zip.on("entry", (entry) => {
      names.push(entry.fileName);
      zip.readEntry();
    });
    zip.on("end", () => resolve(names));
    zip.on("error", reject);
  }),
);
for (const required of ["manifest.json", "dist/server.cjs", "assets/icon.svg"])
  if (!entries.includes(required))
    throw new Error(`Bundle missing ${required}`);
if (
  entries.some(
    (entry) => entry.includes("auth.bin") || entry.includes("node_modules"),
  )
)
  throw new Error("Bundle contains prohibited content");
process.stdout.write("MCPB bundle verified\n");

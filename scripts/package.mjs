import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import archiver from "archiver";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (
  manifest.manifest_version !== "0.3" ||
  manifest.compatibility?.platforms?.length !== 1 ||
  manifest.compatibility.platforms[0] !== "win32"
)
  throw new Error("Manifest must be MCPB 0.3 and Windows-only");
await access("dist/server.cjs");
await mkdir("dist", { recursive: true });
const output = `dist/monarch-for-claude-${manifest.version}.mcpb`;
await new Promise((resolve, reject) => {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const stream = createWriteStream(output);
  stream.on("close", resolve);
  stream.on("error", reject);
  archive.on("error", reject);
  archive.pipe(stream);
  for (const file of [
    "manifest.json",
    "README.md",
    "SECURITY.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "dist/server.cjs",
    "assets/icon.svg",
  ])
    archive.file(file, { name: file });
  archive.finalize();
});
const digest = await new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(output)
    .on("data", (chunk) => hash.update(chunk))
    .on("error", reject)
    .on("end", () => resolve(hash.digest("hex")));
});
await writeFile(
  `${output}.sha256`,
  `${digest}  ${output.split("/").pop()}\n`,
  "utf8",
);
process.stdout.write(`${output}\n`);

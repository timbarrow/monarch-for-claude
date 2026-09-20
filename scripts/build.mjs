import { build } from "esbuild";
import { rm, mkdir } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/server.cjs",
  sourcemap: false,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
});

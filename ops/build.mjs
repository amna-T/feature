// Builds the Node services to plain JavaScript for hosting: `npm run build`.
//
// Running under `npx tsx` compiled TypeScript at start-up and kept the
// compiler in memory, which costs start time and heap on a 512 MB container.
// Each service is bundled to one ESM file in dist/<service>/index.js.
// Workspace packages (@filspay/*) point at TypeScript sources, so they are
// bundled in; every npm dependency stays external and is loaded from
// node_modules at run time (argon2 and sharp are native and can't be bundled).
import { build } from "esbuild";

const keepNpmPackagesExternal = {
  name: "keep-npm-packages-external",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@filspay/")) return undefined;
      return { path: args.path, external: true };
    });
  },
};

const services = [
  { name: "api", entry: "apps/api/src/index.ts" },
  { name: "reporting", entry: "apps/reporting/src/index.ts" },
];

for (const service of services) {
  await build({
    entryPoints: [service.entry],
    outfile: `dist/${service.name}/index.js`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    plugins: [keepNpmPackagesExternal],
    logLevel: "info",
  });
}

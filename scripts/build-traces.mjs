import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function productionTraces() {
  const traces = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".nft.json")) traces.push(path);
    }
  }
  visit(".next/server");
  for (const path of [
    ".next/next-server.js.nft.json",
    ".next/next-minimal-server.js.nft.json",
  ])
    if (existsSync(path)) traces.push(resolve(path));
  return traces;
}

export function isPrivateBuildFile(file, tracePath) {
  const path = relative(
    resolve("."),
    resolve(dirname(tracePath), file),
  ).replaceAll("\\", "/");
  return /^(?:(?:data|scratch|test-results|\.wwebjs_auth|\.wwebjs_cache)\/|\.env(?:\.|$)|RemoteAuth-.*\.zip$)/.test(
    path,
  );
}

// Next's Windows trace exclusions do not reliably normalize path separators.
// Edit only build manifests; runtime files themselves are never touched.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let removed = 0;
  for (const path of productionTraces()) {
    const trace = JSON.parse(readFileSync(path, "utf8"));
    const files = trace.files.filter((file) => !isPrivateBuildFile(file, path));
    removed += trace.files.length - files.length;
    if (files.length !== trace.files.length)
      writeFileSync(path, JSON.stringify({ ...trace, files }));
  }
  console.log(
    `[FastBus] Build: ${removed} referência(s) a dados privados excluída(s) dos manifests.`,
  );
}

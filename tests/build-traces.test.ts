import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, relative, resolve } from "node:path";
import { isPrivateBuildFile } from "../scripts/build-traces.mjs";

test("production tracing excludes private runtime files without excluding application dependencies", () => {
  const trace = resolve(".next/server/app/api/monitors/route.js.nft.json");
  for (const file of [
    "data/fastbus.sqlite",
    "data/runtime/sender/secret",
    "scratch/capture.json",
    "test-results/output.json",
    ".env",
    ".env.local",
    ".env.production",
    ".wwebjs_auth/session/key",
    ".wwebjs_cache/page",
    "RemoteAuth-fastbus.zip",
  ])
    assert.equal(
      isPrivateBuildFile(relative(dirname(trace), resolve(file)), trace),
      true,
      file,
    );
  for (const file of [
    "lib/server/db.ts",
    "node_modules/next/dist/data/file.js",
    "package.json",
    "public/icon.svg",
  ])
    assert.equal(
      isPrivateBuildFile(relative(dirname(trace), resolve(file)), trace),
      false,
      file,
    );
});

import { build } from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
mkdirSync(".fastbus-cloud", { recursive: true });
await build({
  entryPoints: ["scripts/cloud-worker.ts"],
  outfile: ".fastbus-cloud/worker.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  packages: "external",
});
await build({
  entryPoints: ["scripts/daytona-whatsapp.ts"],
  outfile: ".fastbus-cloud/daytona-whatsapp.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  packages: "external",
});
if (existsSync("data/browser-extensions/browsec/manifest.json")) {
  execFileSync(
    "tar",
    [
      "-czf",
      ".fastbus-cloud/browsec.tar.gz",
      "-C",
      "data/browser-extensions",
      "browsec",
    ],
    { windowsHide: true },
  );
}
if (
  process.env.FASTBUS_CLOUD_MODE === "daily" &&
  process.env.CLICKBUS_NETWORK_MODE === "extension" &&
  !existsSync(".fastbus-cloud/browsec.tar.gz")
)
  throw new Error("Missing packaged browser extension");

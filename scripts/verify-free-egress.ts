/** Isolated extension/egress check. Never visits a bus provider or receives database/WhatsApp credentials. */
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { Sandbox } from "@vercel/sandbox";
import { getAuth } from "@vercel/sandbox/dist/auth/index.js";
import { loadCloudEnvironment } from "./cloud-environment";

let stage = "CONFIGURATION";

async function main() {
  const bundle = await build({
    stdin: {
      contents: `import { checkClickBusBrowser, closeClickBusBrowser } from './lib/scrapers/clickbus/browser'; import { freeBrowserEgress } from './lib/monitoring/free-egress'; import { diagnosticCode } from './lib/monitoring/diagnostics'; (async () => { try { await checkClickBusBrowser(); console.log('VPN_VERIFIED:' + freeBrowserEgress().code); } catch(e) { console.error(diagnosticCode(e)); if (process.env.FASTBUS_VPN_PROBE_VERBOSE === '1') console.error(String(e).slice(0,2500)); process.exitCode=1; } finally { await closeClickBusBrowser(); } })();`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    target: "node24",
    format: "cjs",
    packages: "external",
  });
  if (process.argv.includes("--bundle-only")) {
    await writeFile(
      ".fastbus-cloud/vpn-check.cjs",
      bundle.outputFiles[0].contents,
    );
    console.log("VPN_CHECK_BUNDLE_READY");
    return;
  }
  stage = "SANDBOX_CREATION";
  loadCloudEnvironment();
  const auth = getAuth();
  const project = JSON.parse(await readFile(".vercel/project.json", "utf8"));
  if (!process.env.FASTBUS_SANDBOX_SNAPSHOT) throw new Error("SNAPSHOT_REQUIRED");
  const sandbox = await Sandbox.create({
    token:
      process.env.VERCEL_TOKEN || auth?.token || process.env.VERCEL_OIDC_TOKEN!,
    teamId: project.orgId,
    projectId: project.projectId,
    source: {
      type: "snapshot",
      snapshotId: process.env.FASTBUS_SANDBOX_SNAPSHOT,
    },
    timeout: 120000,
    persistent: false,
    resources: { vcpus: 2 },
    env: {
      CLICKBUS_NETWORK_MODE: "extension",
      CLICKBUS_BROWSEC_EXTENSION_PATH: "browsec",
      CLICKBUS_BROWSER_HEADLESS: "false",
      CLICKBUS_FREE_VPN_ROTATION: "1",
      FASTBUS_RUNTIME_DIR: "/tmp/fastbus-vpn-check",
      PLAYWRIGHT_BROWSERS_PATH: "/opt/fastbus-browsers",
    },
  });
  try {
    stage = "VPN_EXECUTION";
    await sandbox.writeFiles([
      {
        path: "vpn-check.cjs",
        content: Buffer.from(bundle.outputFiles[0].contents),
      },
      {
        path: "browsec.tar.gz",
        content: await readFile(".fastbus-cloud/browsec.tar.gz"),
      },
    ]);
    const command = await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        `tar -xzf browsec.tar.gz && export CLICKBUS_BROWSER_PATH="$(node -e 'process.stdout.write(require("playwright-core").chromium.executablePath())')" && timeout 85s dbus-run-session -- xvfb-run -a node vpn-check.cjs`,
      ],
    });
    const out = await command.stdout();
    const verified = out.match(/VPN_VERIFIED:(US|NL|GB|SG)/)?.[0];
    if (command.exitCode !== 0 || !verified) {
      const err = await command.stderr();
      const code =
        err.match(/\bCLICKBUS_[A-Z_]{1,65}\b/)?.[0] || "VPN_CHECK_FAILED";
      throw new Error(code);
    }
    console.log(verified);
  } finally {
    await sandbox.stop();
  }
}
void main().catch((e) => {
  console.error(
    e instanceof Error && /^[A-Z_]{1,80}$/.test(e.message)
      ? e.message
      : `VPN_CHECK_FAILED_AT_${stage}`,
  );
  if (typeof e?.status === "number") console.error(`HTTP_STATUS_${e.status}`);
  process.exitCode = 1;
});

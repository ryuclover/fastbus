import { config } from "dotenv";
config({ path: ".env.vercel.cloud.local", quiet: true });
import { readFileSync, appendFileSync } from "node:fs";
import { Sandbox } from "@vercel/sandbox";

async function main() {
  const project = JSON.parse(readFileSync(".vercel/project.json", "utf8"));
  const sandbox = await Sandbox.create({
    token: process.env.VERCEL_OIDC_TOKEN!,
    teamId: project.orgId,
    projectId: project.projectId,
    image: "vercel/sandbox/universal:latest",
    resources: { vcpus: 2 },
    timeout: 900000,
    persistent: false,
  });
  try {
    await sandbox.writeFiles(
      ["package.json", "package-lock.json"].map((path) => ({
        path,
        content: readFileSync(path),
      })),
    );
    const install = await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        "PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev --ignore-scripts > /tmp/npm-install.log 2>&1 && echo Dependencies-installed || (tail -n 15 /tmp/npm-install.log; exit 1)",
      ],
    });
    console.log(await install.stdout());
    if (install.exitCode)
      throw new Error("Cloud dependencies installation failed");
    const browser = await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        "PLAYWRIGHT_BROWSERS_PATH=/opt/fastbus-browsers node node_modules/playwright-core/cli.js install --with-deps chromium > /tmp/browser-install.log 2>&1 && apt-get install -y xvfb dbus-x11 gsettings-desktop-schemas libgl1-mesa-dri >> /tmp/browser-install.log 2>&1 && echo Browser-installed || (tail -n 25 /tmp/browser-install.log; exit 1)",
      ],
      sudo: true,
    });
    console.log(await browser.stdout());
    if (browser.exitCode) throw new Error("Cloud browser installation failed");
    const check = await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        "PLAYWRIGHT_BROWSERS_PATH=/opt/fastbus-browsers node -e 'const {chromium}=require(\"playwright-core\");(async()=>{const b=await chromium.launch({chromiumSandbox:true});console.log(chromium.executablePath());await b.close()})().catch(e=>{console.error(e.message);process.exitCode=1})'",
      ],
    });
    console.log(await check.stdout());
    if (check.exitCode) {
      console.log(await check.stderr());
      throw new Error("Cloud browser verification failed");
    }
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    appendFileSync(
      ".env.vercel.cloud.local",
      `\nFASTBUS_SANDBOX_SNAPSHOT=${snapshot.snapshotId}\n`,
    );
    console.log("Clean runtime snapshot ready.");
  } finally {
    await sandbox.stop().catch(() => {});
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Runtime preparation failed",
  );
  process.exitCode = 1;
});

import { config } from "dotenv";
/** The CLI may redact sensitive variables when refreshing an existing file. */
export function loadCloudEnvironment() {
  config({ path: ".env.local", quiet: true });
  const cloud: Record<string, string> = {};
  config({ path: ".env.vercel.cloud.local", quiet: true, processEnv: cloud });
  for (const [name, value] of Object.entries(cloud))
    if (value !== "[SENSITIVE]") process.env[name] = value;
  config({ path: ".env.daytona.local", quiet: true, override: true });
}

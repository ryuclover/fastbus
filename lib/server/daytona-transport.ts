import type { Sandbox } from "@daytona/sdk";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AlertTransport } from "../monitoring/whatsapp";

const stateSchema = z
  .object({
    status: z.enum([
      "connecting",
      "qr",
      "authenticated",
      "ready",
      "saved",
      "error",
      "fixture",
    ]),
    stable: z.boolean(),
    qr: z
      .string()
      .max(20000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
      .optional(),
    qrExpires: z.number().optional(),
    error: z
      .string()
      .regex(/^[A-Z_]{1,70}$/)
      .optional(),
  })
  .strict();
export type DaytonaChannel = {
  state(): Promise<z.infer<typeof stateSchema>>;
  checkpoint(): Promise<void>;
  stop(revoke?: boolean): Promise<void>;
  transport: AlertTransport;
};

/** A narrow WhatsApp channel: no database credentials, SQL, shell or arbitrary HTTP operations. */
export async function withDaytonaChannel<T>(
  sandbox: Sandbox,
  worker: Buffer,
  reset: boolean,
  mode: string,
  deadline: number,
  operation: (channel: DaytonaChannel) => Promise<T>,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  if (!/^(pair|verify|deliver|diagnostic|smoke)$/.test(mode))
    throw new Error("INVALID_JOB_MODE");
  const wasRunning = String(sandbox.state).toLowerCase() === "started";
  const secret = randomBytes(32).toString("hex");
  let startedHere = false;
  let channel: DaytonaChannel | undefined;
  try {
    if (!wasRunning) {
      startedHere = true;
      await sandbox.start(70);
    }
    if (Date.now() > deadline - 90000) throw new Error("DAYTONA_START_TIMEOUT");
    await sandbox.fs.uploadFile(
      worker,
      "/home/daytona/fastbus/daytona-whatsapp.cjs",
    );
    const launch = await sandbox.process.executeCommand(
      `flock -n /home/daytona/fastbus/worker.lock timeout --signal=TERM --kill-after=10s 185s dbus-run-session -- xvfb-run -a node daytona-whatsapp.cjs ${mode} > whatsapp-worker.log 2>&1 < /dev/null &`,
      "/home/daytona/fastbus",
      { FASTBUS_JOB_SECRET: secret, FASTBUS_RESET_PROFILE: reset ? "1" : "0" },
      15,
    );
    if (launch.exitCode !== 0) throw new Error("DAYTONA_WORKER_FAILED");
    const preview = await sandbox.getPreviewLink(30377);
    if (new URL(preview.url).protocol !== "https:")
      throw new Error("INVALID_RUNTIME_URL");
    const request = async (path: string, body?: unknown) => {
      const response = await fetcher(
        `${preview.url.replace(/\/$/, "")}${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
            "X-Daytona-Skip-Preview-Warning": "true",
            ...(preview.token
              ? { "X-Daytona-Preview-Token": preview.token }
              : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(
            path === "/send" ? 35000 : path === "/checkpoint" ? 25000 : 10000,
          ),
          cache: "no-store",
          redirect: "error",
        },
      );
      if (response.status === 401) throw new Error("DAYTONA_BUSY");
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          typeof result.error === "string" &&
            /^[A-Z_]{1,70}$/.test(result.error)
            ? result.error
            : "DAYTONA_OPERATION_FAILED",
        );
      return result;
    };
    channel = {
      state: async () => stateSchema.parse(await request("/state")),
      checkpoint: async () => {
        if ((await request("/checkpoint", {})).saved !== true)
          throw new Error("SESSION_BACKUP_FAILED");
      },
      stop: async (revoke = false) => {
        await request("/stop", { revoke });
      },
      transport: {
        getNumberId: async (phone) =>
          z
            .object({
              recipient: z
                .object({ _serialized: z.string().max(100) })
                .nullable(),
            })
            .parse(await request("/number", { phone })).recipient,
        sendMessage: async (to, text) => {
          if (
            (await request("/send", { id: randomUUID(), to, text }))
              .accepted !== true
          )
            throw new Error("SEND_UNCONFIRMED");
        },
      },
    };
    const startupDeadline = Math.min(deadline - 30000, Date.now() + 30000);
    while (true) {
      try {
        await channel.state();
        break;
      } catch (error) {
        if (error instanceof Error && error.message === "DAYTONA_BUSY")
          throw error;
        if (Date.now() >= startupDeadline)
          throw new Error("DAYTONA_START_TIMEOUT");
        await delay(1000);
      }
    }
    return await operation(channel);
  } finally {
    await channel?.stop().catch(() => {});
    if (startedHere || process.env.FASTBUS_DAYTONA_STOP_POLICY === "always")
      await sandbox.stop(25);
  }
}

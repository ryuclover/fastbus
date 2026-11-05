import { test } from "node:test";
import assert from "node:assert/strict";
import { withDaytonaChannel } from "../lib/server/daytona-transport";

test("Daytona preserves active SSH workspaces, closes its own runtime on failure, and sends no database credentials", async () => {
  delete process.env.FASTBUS_DAYTONA_STOP_POLICY;
  for (const state of ["started", "archived"])
    for (const fail of [false, true]) {
      const calls: string[] = [];
      let secret = "";
      const workspace = {
        state,
        start: async () => {
          calls.push("start-workspace");
        },
        stop: async () => {
          calls.push("stop-workspace");
        },
        fs: {
          uploadFile: async () => {
            calls.push("upload");
          },
        },
        process: {
          executeCommand: async (
            command: string,
            cwd: string,
            env: Record<string, string>,
          ) => {
            calls.push("launch");
            assert.match(command, /^flock -n .* timeout /);
            assert.ok(command.includes("daytona-whatsapp.cjs verify"));
            assert.equal(cwd, "/home/daytona/fastbus");
            assert.deepEqual(Object.keys(env).sort(), [
              "FASTBUS_JOB_SECRET",
              "FASTBUS_RESET_PROFILE",
            ]);
            secret = env.FASTBUS_JOB_SECRET;
            return { exitCode: 0 };
          },
        },
        getPreviewLink: async () => ({
          url: "https://runtime.example",
          token: "preview-fixture",
        }),
      };
      const fetcher = async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("Authorization"), `Bearer ${secret}`);
        assert.equal(headers.get("X-Daytona-Preview-Token"), "preview-fixture");
        const path = new URL(String(url)).pathname;
        if (path === "/stop") calls.push("stop-process");
        return Response.json(
          path === "/state"
            ? { status: "ready", stable: true }
            : path === "/number"
              ? { recipient: { _serialized: "5521999999999@c.us" } }
              : path === "/send"
                ? { accepted: true }
                : path === "/checkpoint"
                  ? { saved: true }
                  : { stopped: true },
        );
      };
      const action = withDaytonaChannel(
        workspace as never,
        Buffer.from("fixture"),
        false,
        "verify",
        Date.now() + 260000,
        async (channel) => {
          if (fail) throw new Error("FIXTURE_FAILURE");
          assert.equal((await channel.state()).status, "ready");
          await channel.transport.getNumberId("5521999999999");
          await channel.transport.sendMessage("5521999999999@c.us", "Fixture", {
            linkPreview: false,
            waitUntilMsgSent: true,
          });
          await channel.checkpoint();
        },
        fetcher as typeof fetch,
      );
      if (fail) await assert.rejects(action, /FIXTURE_FAILURE/);
      else await action;
      assert.equal(calls.includes("stop-process"), true);
      assert.equal(calls.includes("start-workspace"), state !== "started");
      assert.equal(calls.includes("stop-workspace"), state !== "started");
    }
  await assert.rejects(
    withDaytonaChannel(
      {} as never,
      Buffer.alloc(0),
      false,
      "verify; unexpected",
      Date.now(),
      async () => {},
    ),
    /INVALID_JOB_MODE/,
  );
});

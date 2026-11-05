import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

if (existsSync(".env.local")) {
  console.log(
    "O arquivo .env.local já existe. A chave e a configuração foram preservadas.",
  );
} else {
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  const chrome = candidates.find(existsSync) || "";
  writeFileSync(
    ".env.local",
    [
      `FASTBUS_DATA_KEY=${randomBytes(32).toString("hex")}`,
      "APP_ORIGIN=http://localhost:3000",
      "FASTBUS_DATA_DIR=./data",
      "FASTBUS_ALLOW_REGISTRATION=true",
      `WHATSAPP_CHROME_PATH="${chrome}"`,
      "FASTBUS_RUNTIME_DIR=./data/runtime",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Configuração local criada com chave aleatória. Não compartilhe .env.local nem perca sua chave.",
  );
  console.log(
    "Use npm run dev e, em outro terminal, npm run worker. Após criar sua conta, desative novos cadastros.",
  );
}

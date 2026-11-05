import { createWriteStream } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

type Archive = NodeJS.ReadableStream & {
  directory(path: string, destination: false): void;
  finalize(): Promise<void>;
};
const archiver = require("archiver") as (
  format: string,
  options: unknown,
) => Archive;
const unzipper = require("unzipper") as {
  Open: {
    buffer(data: Buffer): Promise<{
      files: { path: string; type: string; uncompressedSize: number }[];
    }>;
  };
};

/** Exclude disposable caches and process locks, not authentication/storage state. */
export function includeProfilePath(root: string, candidate: string) {
  const path = relative(root, candidate);
  if (
    path.startsWith(`..${sep}`) ||
    path === ".." ||
    resolve(candidate) !== resolve(root, path)
  )
    return false;
  return !path
    .split(sep)
    .some((part) =>
      /^(?:Cache|Code Cache|GPUCache|GrShaderCache|ShaderCache|DawnGraphiteCache|Crashpad|BrowserMetrics|Singleton.*|LOCK|lockfile|DevToolsActivePort)$/.test(
        part,
      ),
    );
}
export async function assertSessionArchive(archive: Buffer) {
  const zip = await unzipper.Open.buffer(archive);
  const files = zip.files.filter(
    (file) => file.type === "File" && file.uncompressedSize > 0,
  );
  for (const directory of ["Default/IndexedDB/", "Default/Local Storage/"]) {
    if (!files.some((file) => file.path.startsWith(directory)))
      throw new Error("SESSION_BACKUP_INCOMPLETE");
  }
  for (const file of zip.files) {
    if (
      file.path.includes("\\") ||
      file.path.startsWith("/") ||
      file.path.split("/").includes("..") ||
      /^[a-z]:/i.test(file.path)
    )
      throw new Error("SESSION_BACKUP_INVALID");
  }
}
export async function archiveSessionProfile(
  profile: string,
  stage: string,
  archivePath: string,
) {
  // All paths are supplied by RemoteAuth under its private runtime directory.
  const root = dirname(resolve(profile));
  if (
    !resolve(stage).startsWith(root + sep) ||
    !resolve(archivePath).startsWith(root + sep) ||
    resolve(profile) === resolve(stage) ||
    resolve(stage).startsWith(resolve(profile) + sep)
  )
    throw new Error("Invalid profile staging directory");
  await rm(stage, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(stage, { recursive: true, mode: 0o700 });
  await cp(profile, stage, {
    recursive: true,
    force: true,
    filter: (source) => includeProfilePath(profile, source),
  });
  const archive = archiver("zip", { zlib: { level: 1 } });
  const output = createWriteStream(archivePath, { mode: 0o600 });
  await new Promise<void>((done, fail) => {
    output.once("close", done);
    output.once("error", fail);
    archive.once("error", fail);
    archive.pipe(output);
    archive.directory(stage, false);
    void archive.finalize().catch(fail);
  });
  return archivePath;
}

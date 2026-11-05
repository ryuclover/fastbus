import { randomUUID } from "node:crypto";
import { put, get, del } from "@vercel/blob";

export const isBlobBackup = (value: string) => value.startsWith("blob:");
export async function saveSessionBackup(encrypted: string) {
  const result = await put(`fastbus/sender/${randomUUID()}.enc`, encrypted, {
    access: "private",
    contentType: "application/octet-stream",
    addRandomSuffix: false,
  });
  return `blob:${result.url}`;
}
export async function readSessionBackup(value: string) {
  if (!isBlobBackup(value)) return value;
  const result = await get(value.slice(5), {
    access: "private",
    useCache: false,
  });
  if (!result || result.statusCode !== 200)
    throw new Error("Session backup unavailable");
  return await new Response(result.stream).text();
}
export async function deleteSessionBackup(value: string | null | undefined) {
  if (value && isBlobBackup(value)) await del(value.slice(5));
}

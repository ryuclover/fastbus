import { db } from "../server/database";

export async function claimWorker(owner: string) {
  const row = (await db()
    .prepare(
      `INSERT INTO leases(id,owner,expires_at) VALUES ('worker',?,?)
    ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE leases.expires_at<? OR leases.owner=excluded.owner RETURNING owner`,
    )
    .get(owner, Date.now() + 45000, Date.now())) as
    { owner: string } | undefined;
  return row?.owner === owner;
}
export async function releaseWorker(owner: string) {
  await db()
    .prepare("DELETE FROM leases WHERE id='worker' AND owner=?")
    .run(owner);
}

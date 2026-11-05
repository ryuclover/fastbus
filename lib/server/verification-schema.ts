export const verificationSchema = `CREATE TABLE IF NOT EXISTS contact_verifications (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 id TEXT NOT NULL,phone TEXT NOT NULL,code_hash TEXT,code TEXT,
 status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,sent_at INTEGER
);`;

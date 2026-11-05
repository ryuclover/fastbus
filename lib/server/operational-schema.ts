export const operationalSchema = `
CREATE TABLE IF NOT EXISTS observation_prices (
 monitor_id TEXT NOT NULL, fingerprint TEXT NOT NULL, price_minor INTEGER NOT NULL CHECK(price_minor>=0),
 PRIMARY KEY(monitor_id,fingerprint),
 FOREIGN KEY(monitor_id,fingerprint) REFERENCES observations(monitor_id,fingerprint) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS location_mappings (
 provider TEXT NOT NULL, city_key TEXT NOT NULL, scope TEXT NOT NULL,
 slug TEXT NOT NULL, version INTEGER NOT NULL, verified_at INTEGER NOT NULL,
 PRIMARY KEY(provider, city_key, scope)
);
CREATE TABLE IF NOT EXISTS search_jobs (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',code TEXT NOT NULL DEFAULT 'QUEUED',
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS search_jobs_pending ON search_jobs(state,created_at);
CREATE TABLE IF NOT EXISTS diagnostic_jobs (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,payload TEXT,state TEXT NOT NULL DEFAULT 'queued',code TEXT NOT NULL DEFAULT 'QUEUED',
 offers INTEGER,created_at INTEGER NOT NULL,started_at INTEGER,completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS diagnostic_jobs_pending ON diagnostic_jobs(state,created_at);
CREATE TABLE IF NOT EXISTS query_runs (
 id TEXT PRIMARY KEY,monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
 provider TEXT NOT NULL,travel_date TEXT NOT NULL,started_at INTEGER NOT NULL,completed_at INTEGER,code TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS query_runs_monitor ON query_runs(monitor_id,started_at);
CREATE TABLE IF NOT EXISTS password_recovery (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,id TEXT NOT NULL,phone TEXT NOT NULL,
 code_hash TEXT,code TEXT,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL
);`;

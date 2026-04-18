import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const DB_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DB_DIR, "clips.db");

let dbSingleton: Database.Database | null = null;

export const getDb = (): Database.Database => {
  if (dbSingleton) return dbSingleton;

  fs.mkdirSync(DB_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS clips (
      id              TEXT PRIMARY KEY,
      bucket          TEXT NOT NULL,
      filename        TEXT NOT NULL,
      rel_path        TEXT NOT NULL,
      abs_path        TEXT NOT NULL,
      script_line     TEXT NOT NULL,
      tags            TEXT NOT NULL DEFAULT '',
      duration_frames INTEGER NOT NULL,
      imported_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_clips_bucket ON clips(bucket);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_clips_filename ON clips(filename);

    CREATE TABLE IF NOT EXISTS templates (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      buckets_json TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plans (
      id            TEXT PRIMARY KEY,
      template_id   TEXT NOT NULL,
      clip_ids_json TEXT NOT NULL,
      hash          TEXT NOT NULL UNIQUE,
      status        TEXT NOT NULL CHECK (status IN ('pending','rendered','failed')),
      output_path   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      rendered_at   TEXT,
      FOREIGN KEY (template_id) REFERENCES templates(id)
    );

    CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
    CREATE INDEX IF NOT EXISTS idx_plans_template ON plans(template_id);
  `);

  const clipColumns = db
    .prepare(`PRAGMA table_info(clips)`)
    .all() as { name: string }[];
  if (!clipColumns.some((c) => c.name === "tags")) {
    db.exec(
      `ALTER TABLE clips ADD COLUMN tags TEXT NOT NULL DEFAULT ''`,
    );
  }

  dbSingleton = db;
  return db;
};

export type ClipRow = {
  id: string;
  bucket: string;
  filename: string;
  rel_path: string;
  abs_path: string;
  script_line: string;
  tags: string;
  duration_frames: number;
  imported_at: string;
};

export type TemplateRow = {
  id: string;
  name: string;
  buckets_json: string;
  created_at: string;
};

export type PlanRow = {
  id: string;
  template_id: string;
  clip_ids_json: string;
  hash: string;
  status: "pending" | "rendered" | "failed";
  output_path: string | null;
  created_at: string;
  rendered_at: string | null;
};

export const upsertClip = (
  db: Database.Database,
  clip: Omit<ClipRow, "imported_at">,
): void => {
  db.prepare(
    `INSERT INTO clips (id, bucket, filename, rel_path, abs_path, script_line, tags, duration_frames)
     VALUES (@id, @bucket, @filename, @rel_path, @abs_path, @script_line, @tags, @duration_frames)
     ON CONFLICT(id) DO UPDATE SET
       bucket          = excluded.bucket,
       filename        = excluded.filename,
       rel_path        = excluded.rel_path,
       abs_path        = excluded.abs_path,
       script_line     = excluded.script_line,
       tags            = excluded.tags,
       duration_frames = excluded.duration_frames`,
  ).run(clip);
};

export const getClipsByBucket = (
  db: Database.Database,
  bucket: string,
): ClipRow[] => {
  return db
    .prepare<string, ClipRow>(
      `SELECT * FROM clips WHERE bucket = ? ORDER BY filename`,
    )
    .all(bucket);
};

export const getClipsByIds = (
  db: Database.Database,
  ids: string[],
): ClipRow[] => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare<string[], ClipRow>(
      `SELECT * FROM clips WHERE id IN (${placeholders})`,
    )
    .all(...ids);
};

export const upsertTemplate = (
  db: Database.Database,
  template: { id: string; name: string; buckets: string[] },
): void => {
  db.prepare(
    `INSERT INTO templates (id, name, buckets_json) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET buckets_json = excluded.buckets_json`,
  ).run(template.id, template.name, JSON.stringify(template.buckets));
};

export const getTemplateByName = (
  db: Database.Database,
  name: string,
): { id: string; name: string; buckets: string[] } | null => {
  const row = db
    .prepare<string, TemplateRow>(`SELECT * FROM templates WHERE name = ?`)
    .get(name);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    buckets: JSON.parse(row.buckets_json) as string[],
  };
};

export const insertPlan = (
  db: Database.Database,
  plan: {
    id: string;
    template_id: string;
    clip_ids: string[];
    hash: string;
  },
): void => {
  db.prepare(
    `INSERT INTO plans (id, template_id, clip_ids_json, hash, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(
    plan.id,
    plan.template_id,
    JSON.stringify(plan.clip_ids),
    plan.hash,
  );
};

export const getRecentHashes = (
  db: Database.Database,
  templateId: string,
  limit = 50,
): string[] => {
  return db
    .prepare<[string, number], { hash: string }>(
      `SELECT hash FROM plans WHERE template_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(templateId, limit)
    .map((r) => r.hash);
};

export const hashExists = (db: Database.Database, hash: string): boolean => {
  const row = db
    .prepare<string, { c: number }>(
      `SELECT COUNT(*) as c FROM plans WHERE hash = ?`,
    )
    .get(hash);
  return (row?.c ?? 0) > 0;
};

export const getPlan = (
  db: Database.Database,
  id: string,
): PlanRow | null => {
  return (
    db
      .prepare<string, PlanRow>(`SELECT * FROM plans WHERE id = ?`)
      .get(id) ?? null
  );
};

export const getPendingPlans = (db: Database.Database): PlanRow[] => {
  return db
    .prepare<[], PlanRow>(
      `SELECT * FROM plans WHERE status = 'pending' ORDER BY created_at ASC`,
    )
    .all();
};

export const markPlanRendered = (
  db: Database.Database,
  id: string,
  outputPath: string,
): void => {
  db.prepare(
    `UPDATE plans SET status = 'rendered', output_path = ?, rendered_at = datetime('now') WHERE id = ?`,
  ).run(outputPath, id);
};

export const markPlanFailed = (db: Database.Database, id: string): void => {
  db.prepare(`UPDATE plans SET status = 'failed' WHERE id = ?`).run(id);
};

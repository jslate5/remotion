import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import {
  getDb,
  upsertClip,
  upsertTemplate,
  getTemplateByName,
} from "./db";
import {
  getVideoDurationSeconds,
  secondsToFrames,
} from "./video-duration";
import { clipIdFor, newTemplateId, assert } from "./util";
import { SHORT_FORM_FPS } from "../src/ShortForm/schema";

loadEnv({ path: path.resolve(__dirname, "..", ".env") });

const ImportFileSchema = z.object({
  clipsDir: z.string(),
  entries: z
    .array(
      z.object({
        filename: z.string(),
        bucket: z.string(),
        script_line: z.string(),
        tags: z
          .string()
          .optional()
          .transform((s) => (s === undefined ? "" : s.trim())),
      }),
    )
    .min(1),
});

const PUBLIC_CLIPS_DIRNAME = "clips";
const publicClipsDir = path.resolve(
  __dirname,
  "..",
  "public",
  PUBLIC_CLIPS_DIRNAME,
);

const ensureClipsSymlink = (clipsDir: string): void => {
  const resolvedTarget = path.normalize(path.resolve(clipsDir));

  if (!fs.existsSync(resolvedTarget)) {
    throw new Error(
      `clipsDir does not exist: ${resolvedTarget}\nIs your external drive mounted?`,
    );
  }

  fs.mkdirSync(path.dirname(publicClipsDir), { recursive: true });

  // Use lstat only: existsSync() follows symlinks and returns false when the
  // target is missing, which would skip removal and cause EEXIST on symlinkSync.
  let atPublic: fs.Stats | undefined;
  try {
    atPublic = fs.lstatSync(publicClipsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }

  const readlinkAbsolute = (): string => {
    const raw = fs.readlinkSync(publicClipsDir);
    return path.normalize(
      path.isAbsolute(raw)
        ? raw
        : path.resolve(path.dirname(publicClipsDir), raw),
    );
  };

  if (!atPublic) {
    fs.symlinkSync(resolvedTarget, publicClipsDir, "dir");
    console.log(
      `Linked public/${PUBLIC_CLIPS_DIRNAME} -> ${resolvedTarget}`,
    );
    return;
  }

  if (atPublic.isSymbolicLink()) {
    const currentAbs = readlinkAbsolute();
    if (currentAbs === resolvedTarget) {
      return;
    }
    console.log(
      `Updating public/${PUBLIC_CLIPS_DIRNAME} symlink:\n  was -> ${currentAbs}\n  now -> ${resolvedTarget}`,
    );
    fs.unlinkSync(publicClipsDir);
    fs.symlinkSync(resolvedTarget, publicClipsDir, "dir");
    console.log(
      `Linked public/${PUBLIC_CLIPS_DIRNAME} -> ${resolvedTarget}`,
    );
    return;
  }

  throw new Error(
    `public/${PUBLIC_CLIPS_DIRNAME} exists and is not a symlink. Remove or rename it and retry.`,
  );
};

const ensureDefaultTemplate = () => {
  const db = getDb();
  if (getTemplateByName(db, "default")) return;

  const templatePath = path.resolve(
    __dirname,
    "..",
    "templates",
    "default.json",
  );
  if (!fs.existsSync(templatePath)) return;

  const raw = JSON.parse(fs.readFileSync(templatePath, "utf-8")) as {
    name: string;
    buckets: string[];
  };
  upsertTemplate(db, {
    id: newTemplateId(raw.name),
    name: raw.name,
    buckets: raw.buckets,
  });
  console.log(`Registered template "${raw.name}" (${raw.buckets.join(" -> ")})`);
};

export const ingestFromJsonFile = async (jsonPath: string): Promise<void> => {
  const absJsonPath = path.resolve(jsonPath);
  assert(fs.existsSync(absJsonPath), `File not found: ${absJsonPath}`);

  const raw = JSON.parse(fs.readFileSync(absJsonPath, "utf-8"));
  const parsed = ImportFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid import file:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }

  const { clipsDir, entries } = parsed.data;

  let resolvedClipsDir = path.normalize(path.resolve(clipsDir));
  if (!fs.existsSync(resolvedClipsDir)) {
    const fallback = path.dirname(absJsonPath);
    if (fs.existsSync(fallback) && fs.statSync(fallback).isDirectory()) {
      resolvedClipsDir = path.normalize(fallback);
      console.log(
        `clipsDir not found; using directory of import JSON:\n  ${resolvedClipsDir}`,
      );
    }
  }

  ensureClipsSymlink(resolvedClipsDir);
  ensureDefaultTemplate();

  const db = getDb();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const entry of entries) {
    const absPath = path.join(resolvedClipsDir, entry.filename);
    if (!fs.existsSync(absPath)) {
      console.warn(`  [skip] missing file: ${absPath}`);
      skipped++;
      continue;
    }

    let durationInFrames: number;
    try {
      const seconds = await getVideoDurationSeconds(absPath);
      durationInFrames = secondsToFrames(seconds, SHORT_FORM_FPS);
    } catch (err) {
      console.warn(
        `  [skip] could not probe duration for ${entry.filename}: ${
          (err as Error).message
        }`,
      );
      skipped++;
      continue;
    }

    const id = clipIdFor(entry.bucket, entry.filename);
    const existing = db
      .prepare<string, { id: string }>(`SELECT id FROM clips WHERE id = ?`)
      .get(id);

    upsertClip(db, {
      id,
      bucket: entry.bucket,
      filename: entry.filename,
      rel_path: `${PUBLIC_CLIPS_DIRNAME}/${entry.filename}`,
      abs_path: absPath,
      script_line: entry.script_line,
      tags: entry.tags,
      duration_frames: durationInFrames,
    });

    if (existing) {
      updated++;
      console.log(
        `  [update] ${entry.bucket}/${entry.filename} (${durationInFrames}f)`,
      );
    } else {
      inserted++;
      console.log(
        `  [insert] ${entry.bucket}/${entry.filename} (${durationInFrames}f)`,
      );
    }
  }

  console.log(
    `\nDone. inserted=${inserted} updated=${updated} skipped=${skipped}`,
  );
};

const main = async (): Promise<void> => {
  const jsonPath = process.argv[2];
  assert(
    jsonPath,
    "Usage: npm run ingest -- <path-to-scripts.json>\n\nThe JSON should look like scripts-import.example.json.",
  );
  await ingestFromJsonFile(jsonPath);
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  selectComposition,
} from "@remotion/renderer";
import {
  getDb,
  getPlan,
  getPendingPlans,
  getClipsByIds,
  markPlanFailed,
  markPlanRendered,
  type PlanRow,
} from "./db";
import type { ShortFormProps } from "../src/ShortForm/schema";

loadEnv({ path: path.resolve(__dirname, "..", ".env") });

type CliArgs =
  | { mode: "single"; planId: string }
  | { mode: "all" };

const parseArgs = (): CliArgs => {
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all-pending" || arg === "--all") {
      return { mode: "all" };
    }
    if (arg === "--plan" || arg === "-p") {
      const next = argv[++i];
      if (!next) throw new Error("--plan requires a plan id");
      return { mode: "single", planId: next };
    }
  }

  throw new Error(
    "Usage: npm run render -- --all-pending | --plan <plan-id>",
  );
};

const buildProps = (plan: PlanRow): ShortFormProps => {
  const clipIds = JSON.parse(plan.clip_ids_json) as string[];
  const db = getDb();
  const rows = getClipsByIds(db, clipIds);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const clips = clipIds.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new Error(
        `Plan ${plan.id} references missing clip id ${id}. Re-ingest clips?`,
      );
    }
    if (!fs.existsSync(row.abs_path)) {
      throw new Error(
        `Clip file missing on disk: ${row.abs_path}\nIs your external drive mounted?`,
      );
    }
    return {
      // Use a plain relative path so `staticFile()` can resolve it.
      // We provide a custom publicDir when bundling to make this work even if
      // clips live in many different folders on disk.
      src: row.rel_path,
      durationInFrames: row.duration_frames,
    };
  });

  return { clips };
};

const getOutDir = (): string => {
  const configured = process.env.SFS_OUT_DIR?.trim();
  if (!configured) {
    return path.resolve(__dirname, "..", "out");
  }

  // Allow relative paths in .env (resolve relative to short-form-stitcher/).
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(__dirname, "..", configured);
};

const renderPlan = async (
  plan: PlanRow,
  serveUrl: string,
): Promise<string> => {
  const outDir = getOutDir();
  fs.mkdirSync(outDir, { recursive: true });

  const props = buildProps(plan);

  const composition = await selectComposition({
    serveUrl,
    id: "ShortForm",
    inputProps: props,
  });

  const outputLocation = path.join(outDir, `${plan.id}.mp4`);

  console.log(
    `  duration=${composition.durationInFrames}f  dims=${composition.width}x${composition.height}@${composition.fps}fps`,
  );
  console.log(`  output -> ${outputLocation}`);

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    inputProps: props,
    outputLocation,
  });

  return outputLocation;
};

const preparePublicDirForPlans = (
  plans: PlanRow[],
): { publicDir: string; cleanup: () => void } => {
  const clipIds = new Set<string>();
  for (const plan of plans) {
    const ids = JSON.parse(plan.clip_ids_json) as string[];
    for (const id of ids) clipIds.add(id);
  }

  const db = getDb();
  const rows = getClipsByIds(db, [...clipIds]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfs-public-"));
  const clipsDir = path.join(tmp, "clips");
  fs.mkdirSync(clipsDir, { recursive: true });

  for (const row of rows) {
    const dest = path.join(clipsDir, row.filename);
    if (fs.existsSync(dest)) continue;
    // The renderer's built-in HTTP server rejects symlinks, so we must copy.
    fs.copyFileSync(row.abs_path, dest);
  }

  return {
    publicDir: tmp,
    cleanup: () => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const db = getDb();

  let plans: PlanRow[];
  if (args.mode === "all") {
    plans = getPendingPlans(db);
    if (plans.length === 0) {
      console.log("No pending plans to render. Run `npm run plan` first.");
      return;
    }
    console.log(`Rendering ${plans.length} pending plan(s)...`);
  } else {
    const plan = getPlan(db, args.planId);
    if (!plan) throw new Error(`Plan not found: ${args.planId}`);
    plans = [plan];
  }

  const { publicDir, cleanup } = preparePublicDirForPlans(plans);

  console.log("Bundling Remotion project...");
  const entryPoint = path.resolve(__dirname, "..", "src", "index.ts");
  const serveUrl = await bundle({
    entryPoint,
    publicDir,
    webpackOverride: (config) => config,
  });
  console.log(`  serveUrl=${serveUrl}`);

  let ok = 0;
  let failed = 0;
  try {
    for (const plan of plans) {
      console.log(`\nRendering ${plan.id} (hash ${plan.hash.slice(0, 10)})`);
      try {
        const outputLocation = await renderPlan(plan, serveUrl);
        markPlanRendered(db, plan.id, outputLocation);
        ok++;
      } catch (err) {
        console.error(`  [fail] ${(err as Error).message}`);
        markPlanFailed(db, plan.id);
        failed++;
      }
    }
  } finally {
    cleanup();
  }

  console.log(`\nDone. rendered=${ok} failed=${failed}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

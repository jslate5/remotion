import fs from "node:fs";
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
      src: row.rel_path,
      durationInFrames: row.duration_frames,
    };
  });

  return { clips };
};

const OUT_DIR = path.resolve(__dirname, "..", "out");

const renderPlan = async (
  plan: PlanRow,
  serveUrl: string,
): Promise<string> => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const props = buildProps(plan);

  const composition = await selectComposition({
    serveUrl,
    id: "ShortForm",
    inputProps: props,
  });

  const outputLocation = path.join(OUT_DIR, `${plan.id}.mp4`);

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

  console.log("Bundling Remotion project...");
  const entryPoint = path.resolve(__dirname, "..", "src", "index.ts");
  const serveUrl = await bundle({
    entryPoint,
    webpackOverride: (config) => config,
  });
  console.log(`  serveUrl=${serveUrl}`);

  let ok = 0;
  let failed = 0;
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

  console.log(`\nDone. rendered=${ok} failed=${failed}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

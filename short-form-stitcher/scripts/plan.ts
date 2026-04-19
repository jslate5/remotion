import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import {
  getDb,
  getAllClips,
  getClipsByBucket,
  getRecentHashes,
  getTemplateByName,
  hashExists,
  insertPlan,
  upsertTemplate,
} from "./db";
import { getLlmProvider } from "./llm";
import {
  assert,
  hashClipSequence,
  newPlanId,
  newTemplateId,
} from "./util";
import { SHORT_FORM_FPS } from "../src/ShortForm/schema";

loadEnv({ path: path.resolve(__dirname, "..", ".env") });

type CliArgs = {
  mode: "template" | "autonomous";
  templateName: string | null;
  count: number;
};

const parseArgs = (): CliArgs => {
  const argv = process.argv.slice(2);
  let mode: CliArgs["mode"] = "template";
  let templateName: string | null = "default";
  let count = 1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--autonomous") {
      mode = "autonomous";
      templateName = null;
    } else if (arg === "--count" || arg === "-n") {
      const next = argv[++i];
      assert(next, "--count requires a number");
      count = parseInt(next, 10);
      assert(
        Number.isInteger(count) && count > 0,
        `--count must be a positive integer, got ${next}`,
      );
    } else if (mode === "template" && !arg.startsWith("-")) {
      templateName = arg;
    }
  }

  return { mode, templateName, count };
};

const loadTemplateFromDisk = (
  name: string,
): { name: string; buckets: string[] } | null => {
  const p = path.resolve(__dirname, "..", "templates", `${name}.json`);
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as {
    name: string;
    buckets: string[];
  };
  return { name: raw.name, buckets: raw.buckets };
};

const buildCatalog = (
  buckets: string[],
): Record<string, { id: string; script_line: string; tags: string }[]> => {
  const db = getDb();
  const catalog: Record<
    string,
    { id: string; script_line: string; tags: string }[]
  > = {};
  for (const bucket of buckets) {
    const clips = getClipsByBucket(db, bucket);
    catalog[bucket] = clips.map((c) => ({
      id: c.id,
      script_line: c.script_line,
      tags: c.tags,
    }));
  }
  return catalog;
};

type LlmPlansResponse = {
  plans: Array<{
    bucketSelections: Record<string, string>;
  }>;
};

type AutonomousLlmPlansResponse = {
  plans: Array<{
    clipIds: string[];
  }>;
};

const SYSTEM_PROMPT = `You are a short-form video editor's assistant.
You select clips from a catalog to assemble coherent short-form videos.

RULES:
- Output MUST be a JSON object of the exact shape: { "plans": [ { "bucketSelections": { "<bucket>": "<clipId>", ... } }, ... ] }
- Every bucket in the requested template MUST have exactly one selected clip id.
- Every clip id MUST exist in the provided catalog for its bucket.
- Each plan's ordered list of clip ids (in template order) MUST be unique across all plans you return.
- You MUST NOT produce a plan whose ordered clip-id sequence matches any entry in forbiddenHashes. forbiddenHashes are sha256 hashes of the joined clip-id sequence.
- Pick clips whose script_line values flow logically into each other. Prefer narrative continuity between buckets.
- When tags are present on a clip, use them as hints for tone and theme consistency across the selected sequence (e.g. matching or complementary tags between buckets).
- Do not include explanations, comments, or any text outside the JSON object.`;

const AUTONOMOUS_SYSTEM_PROMPT = `You are a short-form video editor's assistant.
You select clips from a catalog to assemble coherent short-form videos.

RULES:
- Output MUST be a JSON object of the exact shape: { "plans": [ { "clipIds": ["<id>", ...] }, ... ] }
- clipIds MUST be an ordered list of clip ids from the catalog.
- Do not repeat the same clip id within a plan.
- Each plan MUST include exactly 1 hook_premise, exactly 1 product_one_liner, and exactly 1 cta clip.
- The first clip MUST be a hook_premise.
- The product_one_liner clip MUST appear before the cta clip.
- The sum of duration_frames across the chosen clips MUST be under maxDurationSeconds.
- Each plan's ordered list of clip ids MUST be unique across all plans you return.
- You MUST NOT produce a plan whose ordered clip-id sequence matches any entry in forbiddenHashes. forbiddenHashes are sha256 hashes of the joined clip-id sequence.
- Pick clips whose script_line values flow logically into each other. Prefer narrative continuity.
- When tags are present on a clip, use them as hints for tone and theme consistency across the selected sequence (e.g. matching or complementary tags).
- Do not include explanations, comments, or any text outside the JSON object.`;

const buildUserPrompt = (args: {
  template: string[];
  catalog: Record<string, { id: string; script_line: string; tags: string }[]>;
  forbiddenHashes: string[];
  count: number;
  previouslyReturnedHashes: string[];
}): string => {
  return JSON.stringify(
    {
      template: args.template,
      catalog: args.catalog,
      forbiddenHashes: args.forbiddenHashes,
      previouslyReturnedHashesThisConversation:
        args.previouslyReturnedHashes,
      count: args.count,
    },
    null,
    2,
  );
};

const buildAutonomousUserPrompt = (args: {
  catalog: Array<{
    id: string;
    bucket: string;
    script_line: string;
    tags: string;
    duration_frames: number;
  }>;
  forbiddenHashes: string[];
  count: number;
  previouslyReturnedHashes: string[];
  maxDurationSeconds: number;
}): string => {
  return JSON.stringify(
    {
      catalog: args.catalog,
      forbiddenHashes: args.forbiddenHashes,
      previouslyReturnedHashesThisConversation: args.previouslyReturnedHashes,
      count: args.count,
      maxDurationSeconds: args.maxDurationSeconds,
    },
    null,
    2,
  );
};

const validatePlan = (
  planCandidate: { bucketSelections: Record<string, string> },
  template: string[],
  catalogIds: Record<string, Set<string>>,
): string[] => {
  const clipIds: string[] = [];
  for (const bucket of template) {
    const id = planCandidate.bucketSelections?.[bucket];
    if (!id) throw new Error(`Plan missing selection for bucket "${bucket}"`);
    if (!catalogIds[bucket].has(id)) {
      throw new Error(
        `Plan references clip id "${id}" which is not in bucket "${bucket}"`,
      );
    }
    clipIds.push(id);
  }
  return clipIds;
};

const REQUIRED_AUTONOMOUS_BUCKETS = [
  "hook_premise",
  "product_one_liner",
  "cta",
] as const;

const validateAutonomousPlan = (args: {
  planCandidate: { clipIds: string[] };
  clipsById: Map<string, { bucket: string; duration_frames: number }>;
  maxDurationSeconds: number;
}): string[] => {
  const clipIds = args.planCandidate.clipIds;
  if (!Array.isArray(clipIds) || clipIds.length === 0) {
    throw new Error("Plan is missing clipIds[]");
  }

  const seen = new Set<string>();
  const buckets: string[] = [];
  let totalFrames = 0;

  for (const id of clipIds) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`Invalid clip id in clipIds: ${String(id)}`);
    }
    if (seen.has(id)) {
      throw new Error(`Plan repeats clip id ${id}`);
    }
    seen.add(id);

    const clip = args.clipsById.get(id);
    if (!clip) {
      throw new Error(`Plan references unknown clip id "${id}"`);
    }
    buckets.push(clip.bucket);
    totalFrames += clip.duration_frames;
  }

  const totalSeconds = totalFrames / SHORT_FORM_FPS;
  if (totalSeconds >= args.maxDurationSeconds) {
    throw new Error(
      `Plan duration ${totalSeconds.toFixed(2)}s exceeds max ${args.maxDurationSeconds}s`,
    );
  }

  for (const requiredBucket of REQUIRED_AUTONOMOUS_BUCKETS) {
    const count = buckets.filter((b) => b === requiredBucket).length;
    if (count !== 1) {
      throw new Error(
        `Plan must contain exactly 1 "${requiredBucket}" clip, got ${count}`,
      );
    }
  }

  if (buckets[0] !== "hook_premise") {
    throw new Error(`First clip must be hook_premise, got "${buckets[0]}"`);
  }

  const productIndex = buckets.indexOf("product_one_liner");
  const ctaIndex = buckets.indexOf("cta");
  if (productIndex === -1 || ctaIndex === -1) {
    throw new Error("Plan missing product_one_liner or cta");
  }
  if (productIndex > ctaIndex) {
    throw new Error("product_one_liner must appear before cta");
  }

  return clipIds;
};

const main = async (): Promise<void> => {
  const db = getDb();
  const { mode, templateName, count } = parseArgs();

  const provider = getLlmProvider();
  console.log(`  LLM provider: ${provider.name}`);

  const MAX_ROUNDS = 3;
  const acceptedPlans: { id: string; clipIds: string[]; hash: string }[] = [];
  const acceptedHashes = new Set<string>();

  if (mode === "autonomous") {
    const maxDurationSeconds = 60;
    console.log(
      `Generating ${count} autonomous plan(s) (max ${maxDurationSeconds}s)...`,
    );

    const autonomousName = "autonomous";
    let templateRow = getTemplateByName(db, autonomousName);
    if (!templateRow) {
      const id = newTemplateId(autonomousName);
      upsertTemplate(db, { id, name: autonomousName, buckets: [autonomousName] });
      templateRow = { id, name: autonomousName, buckets: [autonomousName] };
    }

    const allClips = getAllClips(db);
    const clipsById = new Map(
      allClips.map((c) => [c.id, { bucket: c.bucket, duration_frames: c.duration_frames }]),
    );

    for (const bucket of REQUIRED_AUTONOMOUS_BUCKETS) {
      const countInBucket = allClips.filter((c) => c.bucket === bucket).length;
      if (countInBucket === 0) {
        throw new Error(
          `Required bucket "${bucket}" has no clips. Ingest some before running autonomous plan.`,
        );
      }
      console.log(`  bucket "${bucket}": ${countInBucket} clip(s)`);
    }

    const catalog = allClips.map((c) => ({
      id: c.id,
      bucket: c.bucket,
      script_line: c.script_line,
      tags: c.tags,
      duration_frames: c.duration_frames,
    }));

    const forbiddenHashes = getRecentHashes(db, templateRow.id, 200);
    console.log(`  ${forbiddenHashes.length} previously-used hash(es) loaded`);

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const needed = count - acceptedPlans.length;
      if (needed <= 0) break;

      const forbidden = [...forbiddenHashes, ...acceptedHashes];
      const userPrompt = buildAutonomousUserPrompt({
        catalog,
        forbiddenHashes: forbidden,
        count: needed,
        previouslyReturnedHashes: [...acceptedHashes],
        maxDurationSeconds,
      });

      console.log(
        `\n  round ${round}/${MAX_ROUNDS}: asking LLM for ${needed} plan(s)...`,
      );

      const raw = await provider.complete({
        system: AUTONOMOUS_SYSTEM_PROMPT,
        user: userPrompt,
        jsonMode: true,
      });

      let parsed: AutonomousLlmPlansResponse;
      try {
        parsed = JSON.parse(raw) as AutonomousLlmPlansResponse;
      } catch (err) {
        console.warn(
          `  [round ${round}] LLM returned non-JSON, retrying. err=${(err as Error).message}`,
        );
        continue;
      }

      if (!Array.isArray(parsed.plans)) {
        console.warn(`  [round ${round}] LLM response missing plans array`);
        continue;
      }

      for (const candidate of parsed.plans) {
        if (acceptedPlans.length >= count) break;
        try {
          const clipIds = validateAutonomousPlan({
            planCandidate: candidate,
            clipsById,
            maxDurationSeconds,
          });
          const hash = hashClipSequence(clipIds);

          if (acceptedHashes.has(hash) || forbiddenHashes.includes(hash)) {
            console.log(`    [reject] duplicate hash ${hash.slice(0, 10)}...`);
            continue;
          }
          if (hashExists(db, hash)) {
            console.log(
              `    [reject] hash exists in DB ${hash.slice(0, 10)}...`,
            );
            continue;
          }

          acceptedPlans.push({ id: newPlanId(), clipIds, hash });
          acceptedHashes.add(hash);
          console.log(
            `    [accept] hash ${hash.slice(0, 10)}... clips=${clipIds.join(",")}`,
          );
        } catch (err) {
          console.warn(`    [reject] ${(err as Error).message}`);
        }
      }
    }

    if (acceptedPlans.length < count) {
      console.warn(
        `\nOnly produced ${acceptedPlans.length}/${count} plans after ${MAX_ROUNDS} rounds.`,
      );
    }

    const insertMany = db.transaction(() => {
      for (const plan of acceptedPlans) {
        insertPlan(db, {
          id: plan.id,
          template_id: templateRow.id,
          clip_ids: plan.clipIds,
          hash: plan.hash,
        });
      }
    });
    insertMany();

    console.log(`\nSaved ${acceptedPlans.length} pending plan(s).`);
    for (const plan of acceptedPlans) {
      console.log(`  ${plan.id}  hash=${plan.hash.slice(0, 12)}`);
    }
    return;
  }

  assert(templateName, "Template name is required unless --autonomous is used.");
  console.log(`Generating ${count} plan(s) using template "${templateName}"...`);

  let templateRow = getTemplateByName(db, templateName);
  if (!templateRow) {
    const fromDisk = loadTemplateFromDisk(templateName);
    if (!fromDisk) {
      throw new Error(
        `Template "${templateName}" not found in DB or templates/${templateName}.json`,
      );
    }
    const id = newTemplateId(fromDisk.name);
    upsertTemplate(db, {
      id,
      name: fromDisk.name,
      buckets: fromDisk.buckets,
    });
    templateRow = { id, name: fromDisk.name, buckets: fromDisk.buckets };
    console.log(
      `  Registered template "${templateRow.name}" in DB (${templateRow.buckets.join(" -> ")})`,
    );
  }
  const resolvedTemplate = templateRow;

  const template = resolvedTemplate.buckets;
  const catalog = buildCatalog(template);

  const catalogIds: Record<string, Set<string>> = {};
  for (const bucket of template) {
    catalogIds[bucket] = new Set(catalog[bucket].map((c) => c.id));
    if (catalog[bucket].length === 0) {
      throw new Error(
        `Bucket "${bucket}" has no clips. Ingest some before running plan.`,
      );
    }
    console.log(`  bucket "${bucket}": ${catalog[bucket].length} clip(s)`);
  }

  const forbiddenHashes = getRecentHashes(db, resolvedTemplate.id, 200);
  console.log(`  ${forbiddenHashes.length} previously-used hash(es) loaded`);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const needed = count - acceptedPlans.length;
    if (needed <= 0) break;

    const forbidden = [...forbiddenHashes, ...acceptedHashes];
    const userPrompt = buildUserPrompt({
      template,
      catalog,
      forbiddenHashes: forbidden,
      count: needed,
      previouslyReturnedHashes: [...acceptedHashes],
    });

    console.log(
      `\n  round ${round}/${MAX_ROUNDS}: asking LLM for ${needed} plan(s)...`,
    );

    const raw = await provider.complete({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      jsonMode: true,
    });

    let parsed: LlmPlansResponse;
    try {
      parsed = JSON.parse(raw) as LlmPlansResponse;
    } catch (err) {
      console.warn(
        `  [round ${round}] LLM returned non-JSON, retrying. err=${(err as Error).message}`,
      );
      continue;
    }

    if (!Array.isArray(parsed.plans)) {
      console.warn(`  [round ${round}] LLM response missing plans array`);
      continue;
    }

    for (const candidate of parsed.plans) {
      if (acceptedPlans.length >= count) break;
      try {
        const clipIds = validatePlan(candidate, template, catalogIds);
        const hash = hashClipSequence(clipIds);

        if (acceptedHashes.has(hash) || forbiddenHashes.includes(hash)) {
          console.log(`    [reject] duplicate hash ${hash.slice(0, 10)}...`);
          continue;
        }
        if (hashExists(db, hash)) {
          console.log(
            `    [reject] hash exists in DB ${hash.slice(0, 10)}...`,
          );
          continue;
        }

        acceptedPlans.push({ id: newPlanId(), clipIds, hash });
        acceptedHashes.add(hash);
        console.log(
          `    [accept] hash ${hash.slice(0, 10)}... clips=${clipIds.join(",")}`,
        );
      } catch (err) {
        console.warn(`    [reject] ${(err as Error).message}`);
      }
    }
  }

  if (acceptedPlans.length < count) {
    console.warn(
      `\nOnly produced ${acceptedPlans.length}/${count} plans after ${MAX_ROUNDS} rounds.`,
    );
  }

  const insertMany = db.transaction(() => {
    for (const plan of acceptedPlans) {
      insertPlan(db, {
        id: plan.id,
        template_id: resolvedTemplate.id,
        clip_ids: plan.clipIds,
        hash: plan.hash,
      });
    }
  });
  insertMany();

  console.log(`\nSaved ${acceptedPlans.length} pending plan(s).`);
  for (const plan of acceptedPlans) {
    console.log(`  ${plan.id}  hash=${plan.hash.slice(0, 12)}`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

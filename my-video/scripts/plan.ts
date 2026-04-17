import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import {
  getDb,
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

loadEnv({ path: path.resolve(__dirname, "..", ".env") });

type CliArgs = {
  templateName: string;
  count: number;
};

const parseArgs = (): CliArgs => {
  const argv = process.argv.slice(2);
  let templateName = "default";
  let count = 1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--count" || arg === "-n") {
      const next = argv[++i];
      assert(next, "--count requires a number");
      count = parseInt(next, 10);
      assert(
        Number.isInteger(count) && count > 0,
        `--count must be a positive integer, got ${next}`,
      );
    } else if (!arg.startsWith("-")) {
      templateName = arg;
    }
  }

  return { templateName, count };
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
): Record<string, { id: string; script_line: string }[]> => {
  const db = getDb();
  const catalog: Record<string, { id: string; script_line: string }[]> = {};
  for (const bucket of buckets) {
    const clips = getClipsByBucket(db, bucket);
    catalog[bucket] = clips.map((c) => ({
      id: c.id,
      script_line: c.script_line,
    }));
  }
  return catalog;
};

type LlmPlansResponse = {
  plans: Array<{
    bucketSelections: Record<string, string>;
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
- Do not include explanations, comments, or any text outside the JSON object.`;

const buildUserPrompt = (args: {
  template: string[];
  catalog: Record<string, { id: string; script_line: string }[]>;
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

const main = async (): Promise<void> => {
  const { templateName, count } = parseArgs();
  console.log(
    `Generating ${count} plan(s) using template "${templateName}"...`,
  );

  const db = getDb();

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

  const provider = getLlmProvider();
  console.log(`  LLM provider: ${provider.name}`);

  const acceptedPlans: { id: string; clipIds: string[]; hash: string }[] = [];
  const acceptedHashes = new Set<string>();

  const MAX_ROUNDS = 3;
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

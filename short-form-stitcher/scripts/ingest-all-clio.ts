import fs from "node:fs";
import path from "node:path";
import { ingestFromJsonFile } from "./ingest";
import { assert } from "./util";

const DEFAULT_CLIPS_ROOT = "/Volumes/iphone-ext/Editing/Assembly/clips";

/** Matches e.g. clio23.json, clio24.json (not other *.json). */
const isClioImportJson = (filename: string): boolean =>
  /^clio.*\.json$/i.test(filename);

const listClioJsonFiles = (root: string): string[] => {
  const dirents = fs.readdirSync(root, { withFileTypes: true });
  const paths: string[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const sub = path.join(root, d.name);
    for (const f of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!f.isFile() || !isClioImportJson(f.name)) continue;
      paths.push(path.join(sub, f.name));
    }
  }
  paths.sort();
  return paths;
};

const main = async (): Promise<void> => {
  const root = path.resolve(process.argv[2] ?? DEFAULT_CLIPS_ROOT);
  assert(
    fs.existsSync(root),
    `Clips root does not exist: ${root}\nPass a different path as the first argument, or mount the drive.`,
  );
  assert(
    fs.statSync(root).isDirectory(),
    `Not a directory: ${root}`,
  );

  const files = listClioJsonFiles(root);
  if (files.length === 0) {
    console.warn(
      `No clio*.json files found in immediate subfolders of:\n  ${root}`,
    );
    return;
  }

  console.log(`Found ${files.length} clio*.json file(s) under ${root}\n`);

  for (const f of files) {
    console.log(`\n--- Ingest: ${f} ---\n`);
    await ingestFromJsonFile(f);
  }

  console.log(`\nAll done (${files.length} import file(s)).`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

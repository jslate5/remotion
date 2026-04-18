# Short-Form Clip Stitcher

A CLI tool, built on top of Remotion, that stitches pre-edited short-form clips from an external drive into many unique video variations.

The workflow has two stages:

1. **Outside this tool**: a custom GPT produces a JSON file of script lines (and optional comma-separated **tags** per clip for tone/theme hints). You film and edit each line as a clip (overlays/b-roll already baked in) and save them to an external drive using a convention like `hook_001.mp4`, `cta_003.mp4`.
2. **This tool**: ingest the JSON into SQLite, ask an LLM to assemble N unique orderings of clips per template, and render each ordering to an MP4 with Remotion.

## Repository context

This folder is a **complete Remotion package** that lives inside the [main Remotion repository](https://github.com/remotion-dev/remotion). After you clone that repo, `short-form-stitcher/` is already on disk—you **do not** run `create-video` or scaffold a project named `short-form-stitcher`; that flow is only for starting a brand-new Remotion app in an empty directory.

For Node installation, core concepts (compositions, Studio, rendering), and the full manual, see the [Remotion documentation](https://www.remotion.dev/docs).

## One-time setup

```bash
cd short-form-stitcher
npm install
cp .env.example .env
# Fill in OPENAI_API_KEY (or switch LLM_PROVIDER)
```

The external drive is linked into `public/clips/` automatically by `npm run ingest` (it reads the `clipsDir` field in your import JSON). If the drive isn't mounted when you run ingest or render, the command fails fast with a clear message.

## The three commands

### `npm run ingest -- <path-to-scripts.json>`

Imports clip metadata from the JSON your custom GPT produced. See [`scripts-import.example.json`](./scripts-import.example.json) for the expected shape:

```json
{
  "clipsDir": "/Volumes/YourDrive/short-form-clips",
  "entries": [
    {
      "filename": "hook_001.mp4",
      "bucket": "hook",
      "script_line": "...",
      "tags": "discipline, contrarian"
    },
    {
      "filename": "cta_001.mp4",
      "bucket": "cta",
      "script_line": "...",
      "tags": "waitlist, cta"
    }
  ]
}
```

`tags` is optional. Omit it or use an empty string for clips with no labels; values are stored as plain text (often comma-separated words, as your GPT prefers).

For each entry, ingest:

- Verifies the file exists on the drive.
- Probes its duration (via `@remotion/renderer`’s `getVideoMetadata`, which uses Remotion’s bundled ffprobe).
- Upserts a row in SQLite keyed by `sha256(bucket + filename)`, including `script_line` and `tags`.

Re-running ingest is idempotent: existing clips are updated, new ones are inserted.

### `npm run plan -- <template-name> --count <N>`

Generates `N` deduplicated clip-ordering plans. For the `default` template, bucket order is defined in [`templates/default.json`](./templates/default.json):

```bash
npm run plan -- default --count 5
```

Under the hood:

1. Loads clips grouped by bucket (each clip exposes `id`, `script_line`, and `tags`), plus the last 200 hashes already rendered.
2. Sends an LLM (OpenAI by default) a JSON prompt with the catalog and `forbiddenHashes`.
3. Validates each returned plan, SHA-256 hashes the clip-id sequence, rejects duplicates, retries up to 3 rounds.
4. Writes accepted plans to SQLite with status `pending`.

Templates live in [`templates/`](./templates). Drop in `templates/<name>.json` with any ordered list of buckets and the tool will pick it up the first time you run `plan <name>`.

### `npm run render -- --all-pending`

Or for a single plan:

```bash
npm run render -- --plan <plan-id>
```

Bundles the Remotion project once, then for each plan:

- Resolves every clip's duration from the DB.
- Calls `selectComposition` + `renderMedia` against the `ShortForm` composition.
- Writes `out/<plan-id>.mp4`.
- Flips the plan row to `rendered` (or `failed`).

### `npm run preview` (optional)

Opens Remotion Studio so you can scrub a plan visually. Edit the `ShortForm` composition's default props in `src/Root.tsx` — or register a second composition with hard-coded props — if you want a specific plan to show up there.

## Database

SQLite lives at `data/clips.db` (gitignored). Three tables:

- `clips` — one row per ingested clip (`filename`, `bucket`, `script_line`, `tags`, paths, duration, etc.).
- `templates` — named ordered lists of buckets.
- `plans` — each an ordered list of clip ids with a unique `hash` so we never render the same combination twice.

## Project layout

```
short-form-stitcher/
├── src/ShortForm/        # Remotion composition (stitches clips back-to-back)
├── scripts/              # CLI tool (ingest / plan / render)
│   ├── db.ts             # SQLite schema + queries
│   ├── llm/              # Pluggable LLM providers (openai/anthropic/gemini)
│   ├── ingest.ts
│   ├── plan.ts
│   └── render.ts
├── templates/default.json
├── public/clips          # Symlink to external drive (created by ingest)
├── data/                 # SQLite DB (gitignored)
└── out/                  # Rendered MP4s (gitignored)
```

## Switching LLM providers

The `LlmProvider` interface in [`scripts/llm/index.ts`](./scripts/llm/index.ts) is picked by the `LLM_PROVIDER` env var. OpenAI is the only provider fully implemented; `anthropic.ts` and `gemini.ts` are stubs. To add one, install the SDK and implement a `complete({ system, user, jsonMode })` function that returns a string (a JSON object when `jsonMode` is true).

## Out of scope for this MVP

- Music, overlays, transitions — clips are assumed pre-edited.
- GUI — CLI + Remotion Studio only.
- Auto-transcription — script lines come from your external GPT.
- Cloud rendering — local only (add `@remotion/lambda` later if needed).

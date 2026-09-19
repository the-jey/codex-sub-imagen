---
name: codex-imagen
description: Generate or edit bitmap images with GPT Image 2.5 (Sunburst/Flare) through Codex. Use when the user asks for AI image generation, image editing, image-to-image, posters, product shots, or background replacement.
compatibility: Requires the pi CLI with the codex-sub-imagen package and an openai-codex login (check with `pi auth check --provider openai-codex`).
metadata:
  package: codex-sub-imagen
  tool: codex_generate_image
---

# Codex Imagen

Generate and edit bitmap images with GPT Image 2.5 through Codex, using the
`codex-sub-imagen` Pi extension. Authentication reuses the local `openai-codex`
login — never ask for, print, or duplicate API keys.

## Which path to use

- **`codex_generate_image` tool is available** (Pi with the package installed):
  call the tool directly. Do NOT shell out to `pi`.
- **Tool is NOT available** (Claude Code, Codex CLI, Grok, Zed, any other
  harness): shell out via [scripts/generate.mjs](scripts/generate.mjs), which
  drives `pi -p` for you. Requires `pi` on `PATH` plus the package and login.

Never pass a `gpt-image-*` value as `routerModel`. Omit `routerModel` unless a
Codex controller override is explicitly required.

## Native tool call (preferred in Pi)

```json
{
  "prompt": "A cinematic editorial poster with extremely sharp typography",
  "imageModel": "gpt-image-2.5-sunburst",
  "quality": "xhigh",
  "size": "1536x1024",
  "outputFormat": "png",
  "save": "project"
}
```

Reference images: pass local files via `imagePaths` (max 4, PNG/JPEG/WebP/GIF,
20 MiB each). Images attached to the latest user message are included by
default; set `useAttachedImages: false` to disable.

## External harness via script

```bash
# Prerequisite check (pi + package + openai-codex login)
node <skill-dir>/scripts/generate.mjs --check

# Preview the exact pi invocation without calling it
node <skill-dir>/scripts/generate.mjs --dry-run --prompt "A friendly robot reading in a warm library"

# High-fidelity generation (default Sunburst)
node <skill-dir>/scripts/generate.mjs --prompt "Cinematic editorial poster, sharp typography" \
  --quality xhigh --size 1536x1024 --format png --save project

# Faster generation with Flare
node <skill-dir>/scripts/generate.mjs --prompt "A friendly robot reading in a warm library" \
  --image-model flare --quality low

# Edit a local image (repeat --ref up to 4 times)
node <skill-dir>/scripts/generate.mjs --prompt "Keep the subject unchanged, minimal studio background" \
  --ref ./reference.png --quality xhigh --format webp --compression 90 --save project
```

`<skill-dir>` is the directory containing this `SKILL.md`. Resolve it before
running (e.g. `~/.claude/skills/codex-imagen` or the `skills/codex-imagen`
folder of the `codex-sub-imagen` checkout). Run the command from the user's
project directory so relative `--ref` paths and `--save project` resolve there.

Full option list: `node <skill-dir>/scripts/generate.mjs --help`.
Full parameter reference: [references/params.md](references/params.md).

## Output

- The script streams Pi's output; the tool saves the file (`project`, `global`,
  or `custom` mode) and returns the image plus its saved path.
- `--save none` returns the image without writing a file.

## Troubleshooting

- `Missing openai-codex credentials` → run `/login` in Pi, select
  `openai-codex`, then retry.
- `Unknown tool codex_generate_image` → install the package:
  `pi install git:github.com/the-jey/codex-sub-imagen`, then `/reload`.
- Transient rate-limit / server errors are retried inside one tool call
  (initial attempt + 3 retries with backoff).
- Transparency is not supported by the backend — use `auto` or `opaque`.

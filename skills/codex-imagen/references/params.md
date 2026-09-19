# Codex Imagen — parameter reference

Mirrors the `codex_generate_image` tool schema. The
[generate script](../scripts/generate.mjs) maps its flags to these parameters.

| Skill flag | Tool parameter | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `--prompt` | `prompt` | string | required | Generation or edit instructions. |
| `--image-model` | `imageModel` | enum | `gpt-image-2.5-sunburst` | `sunburst` (precise, default) or `flare` (faster). |
| `--router-model` | `routerModel` | string | `gpt-5.6-luna` | Controller override; normally omit. Never `gpt-image-*`. |
| `--quality` | `quality` | enum | `auto` | `auto`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `--size` | `size` | string | `auto` | `auto` or `WIDTHxHEIGHT` (see constraints). |
| `--background` | `background` | enum | `auto` | `auto` or `opaque`. Transparency unsupported. |
| `--format` | `outputFormat` | enum | `png` | `png`, `jpeg`, or `webp`. |
| `--compression` | `outputCompression` | integer | — | `0`–`100`, JPEG/WebP only. |
| `--ref` (repeat) | `imagePaths` | string[] | `[]` | Up to 4 local paths (PNG/JPEG/WebP/GIF). |
| `--no-attached` | `useAttachedImages` | boolean | `true` | Exclude latest-message attachments. |
| `--save` | `save` | enum | `global` | `none`, `project`, `global`, `custom`. |
| `--save-dir` | `saveDir` | string | — | Required with `custom`. |

## Custom-size constraints

- Format `WIDTHxHEIGHT`, multiples of 16.
- Aspect ratio between 1:3 and 3:1.
- Each edge ≤ 3840 px; total 655,360–8,294,400 px.

## Reference-image constraints

- Formats: PNG, JPEG, WebP, GIF. Max 4 after deduplication, 20 MiB each.
- Paths absolute or relative to the project; leading `@` stripped.
- Attached images from the latest user message included unless disabled.

## Save modes

| Mode | Destination |
| --- | --- |
| `global` | `~/.pi/agent/generated-images/<session>/` |
| `project` | `<project>/.pi/generated-images/<session>/` |
| `custom` | `<saveDir>/<session>/` |
| `none` | No file written; image returned inline. |

## Legacy aliases (tool-level)

- `model: "gpt-image-2.5-…"` → `imageModel`; other `model` values → `routerModel`.
- `imagePath: "…"` → `imagePaths: ["…"]`.

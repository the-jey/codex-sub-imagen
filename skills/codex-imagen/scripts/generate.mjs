#!/usr/bin/env node
/**
 * generate.mjs — cross-harness wrapper for the codex-sub-imagen Pi extension.
 *
 * Lets any agent harness (Claude Code, Codex CLI, Grok, Zed, plain shell) drive
 * GPT Image 2.5 generation through `pi -p` + the `codex_generate_image` tool,
 * reusing the local `openai-codex` login. No API keys, no duplicated logic.
 *
 * Usage:
 *   node generate.mjs --check
 *   node generate.mjs --dry-run --prompt "..." [options]
 *   node generate.mjs --prompt "..." [--image-model sunburst|flare] [...]
 *
 * Run from the user's project directory so relative --ref paths and
 * `--save project` resolve there.
 */

import { spawnSync } from "node:child_process";

const PI_BIN = process.env.PI_BIN || "pi";
const TOOL = "codex_generate_image";

const IMAGE_MODELS = {
  sunburst: "gpt-image-2.5-sunburst",
  flare: "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst": "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare": "gpt-image-2.5-flare",
};
const QUALITIES = new Set(["auto", "low", "medium", "high", "xhigh", "max"]);
const BACKGROUNDS = new Set(["auto", "opaque"]);
const FORMATS = new Set(["png", "jpeg", "webp"]);
const SAVE_MODES = new Set(["none", "project", "global", "custom"]);

const HELP = `codex-imagen generate.mjs — drive GPT Image 2.5 via pi + codex-sub-imagen

Usage:
  node generate.mjs --check
  node generate.mjs --dry-run --prompt "..." [options]
  node generate.mjs --prompt "..." [options]

Options:
  --prompt <text>        Image generation / edit instructions (required)
  --image-model <m>      sunburst (default, precise) | flare (faster).
                         Full ids gpt-image-2.5-sunburst/flare also accepted.
  --quality <q>          auto|low|medium|high|xhigh|max (default: omit = auto)
  --size <s>             auto or WIDTHxHEIGHT, e.g. 1536x1024 (default: omit)
  --background <b>       auto|opaque (default: omit = auto)
  --format <f>           png|jpeg|webp (default: omit = png)
  --compression <0-100>  JPEG/WebP compression level (default: omit)
  --ref <path>           Reference image (repeat up to 4x). Also: --image-path
  --no-attached          Exclude latest-message image attachments
  --save <mode>          none|project|global|custom (default: omit = global)
  --save-dir <dir>       Base dir, required with --save custom
  --router-model <id>    Advanced: Codex controller override. Normally omit.
                         Never a gpt-image-* value.
  --check                Verify pi binary + package tool + openai-codex login
  --dry-run              Print the pi invocation without calling it
  --help, -h             Show this help

Env:
  PI_BIN                 pi binary (default: pi)

Examples:
  node generate.mjs --check
  node generate.mjs --prompt "Cinematic poster, sharp typography" --quality xhigh --size 1536x1024 --save project
  node generate.mjs --prompt "Keep subject, studio background" --ref ./a.png --format webp --compression 90 --save project
`;

function fail(msg, code = 2) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { ref: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--check":
        out.check = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--prompt":
        out.prompt = next();
        break;
      case "--image-model":
        out.imageModel = next();
        break;
      case "--quality":
        out.quality = next();
        break;
      case "--size":
        out.size = next();
        break;
      case "--background":
        out.background = next();
        break;
      case "--format":
        out.format = next();
        break;
      case "--compression":
        out.compression = next();
        break;
      case "--ref":
      case "--image-path":
      case "--image-paths":
        out.ref.push(next());
        break;
      case "--no-attached":
        out.noAttached = true;
        break;
      case "--save":
        out.save = next();
        break;
      case "--save-dir":
        out.saveDir = next();
        break;
      case "--router-model":
        out.routerModel = next();
        break;
      default:
        fail(`unknown argument: ${a} (see --help)`);
    }
  }
  return out;
}

function buildToolArgs(o) {
  if (!o.prompt || !o.prompt.trim()) fail("--prompt is required");
  const args = { prompt: o.prompt.trim() };

  if (o.imageModel !== undefined) {
    const key = String(o.imageModel).trim().toLowerCase();
    if (!IMAGE_MODELS[key]) fail(`--image-model must be one of: sunburst, flare (got ${o.imageModel})`);
    args.imageModel = IMAGE_MODELS[key];
  }
  if (o.quality !== undefined) {
    const q = String(o.quality).trim().toLowerCase();
    if (!QUALITIES.has(q)) fail(`--quality must be one of: ${[...QUALITIES].join("|")}`);
    args.quality = q;
  }
  if (o.size !== undefined) args.size = String(o.size).trim();
  if (o.background !== undefined) {
    const b = String(o.background).trim().toLowerCase();
    if (!BACKGROUNDS.has(b)) fail("--background must be auto|opaque");
    args.background = b;
  }
  if (o.format !== undefined) {
    const f = String(o.format).trim().toLowerCase();
    if (!FORMATS.has(f)) fail("--format must be png|jpeg|webp");
    args.outputFormat = f;
  }
  if (o.compression !== undefined) {
    const n = Number(o.compression);
    if (!Number.isInteger(n) || n < 0 || n > 100) fail("--compression must be an integer 0-100");
    if (o.format !== undefined && !["jpeg", "webp"].includes(String(o.format).toLowerCase())) {
      fail("--compression is only supported with --format jpeg|webp");
    }
    args.outputCompression = n;
  }
  if (o.ref.length > 0) {
    if (o.ref.length > 4) fail(`too many --ref paths (${o.ref.length}); maximum 4`);
    args.imagePaths = [...o.ref];
  }
  if (o.noAttached) args.useAttachedImages = false;
  if (o.save !== undefined) {
    const s = String(o.save).trim().toLowerCase();
    if (!SAVE_MODES.has(s)) fail("--save must be none|project|global|custom");
    args.save = s;
  }
  if (o.saveDir !== undefined) args.saveDir = o.saveDir;
  if (o.save === "custom" && !o.saveDir) fail("--save custom requires --save-dir");
  if (o.routerModel !== undefined) {
    const r = String(o.routerModel).trim();
    if (/^gpt-image(?:-|$)/i.test(r)) fail("--router-model must never be a gpt-image-* value; omit it");
    if (r) args.routerModel = r;
  }
  return args;
}

function buildInstruction(toolArgs) {
  return (
    `Call ${TOOL} with exactly these arguments (JSON, single call, no questions):\n` +
    "```json\n" +
    JSON.stringify(toolArgs, null, 2) +
    "\n```\n" +
    "Do not ask for confirmation. If the tool fails, report the error verbatim."
  );
}

function runPi(cmdArgs, { stdio = "inherit" } = {}) {
  const r = spawnSync(PI_BIN, cmdArgs, { stdio, encoding: "utf8" });
  if (r.error) {
    if (r.error.code === "ENOENT") {
      fail(`pi binary not found (${PI_BIN}). Install pi: https://pi.dev`);
    }
    fail(`failed to run ${PI_BIN}: ${r.error.message}`, 1);
  }
  return r;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (opts.check) {
  let ok = true;
  const v = spawnSync(PI_BIN, ["--version"], { encoding: "utf8" });
  if (v.error || v.status !== 0) {
    process.stderr.write(`fail: pi binary not usable (${PI_BIN})\n`);
    ok = false;
  } else {
    process.stdout.write(`ok: pi ${String(v.stdout || "").trim()}\n`);
  }
  const a = spawnSync(PI_BIN, ["auth", "check", "--provider", "openai-codex"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (a.error || a.status !== 0) {
    process.stderr.write("fail: openai-codex login missing/expired. Run /login in pi and select openai-codex.\n");
    if (a.stderr) process.stderr.write(String(a.stderr).slice(0, 500) + "\n");
    ok = false;
  } else {
    process.stdout.write("ok: openai-codex login present\n");
  }
  process.stdout.write(
    (ok ? "ok" : "fail") + ": codex_generate_image tool requires pi install git:github.com/the-jey/codex-sub-imagen (+ /reload)\n",
  );
  process.exit(ok ? 0 : 1);
}

const toolArgs = buildToolArgs(opts);
const instruction = buildInstruction(toolArgs);
const piArgs = ["-p", "-t", TOOL, instruction];

if (opts.dryRun) {
  process.stdout.write(`${PI_BIN} ${piArgs.map((a) => JSON.stringify(a)).join(" ")}\n\n${instruction}\n`);
  process.exit(0);
}

const r = runPi(piArgs);
process.exit(r.status ?? 1);

/**
 * codex-sub-imagen: Codex image generation extension for Pi.
 *
 * Reads the complete SSE response, normalizes legacy router-model arguments,
 * retries transient failures inside one tool call, and supports attached or
 * local reference images for image-to-image generation and editing.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { StringEnum } from '@earendil-works/pi-ai';
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const PROVIDER = 'openai-codex';
const DEFAULT_ROUTER_MODEL = 'gpt-5.6-luna';
const IMAGE_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] as const;
const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0];
const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const IMAGE_BACKGROUNDS = ['auto', 'opaque'] as const;
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const OPENAI_BETA_HEADER = 'responses=experimental';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const CONFIG_FILE_NAME = 'codex-sub-imagen.json';
const LEGACY_CONFIG_FILE_NAME = 'codex-image-gen.json';
const SAVE_MODES = ['none', 'project', 'global', 'custom'] as const;
const OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const;
const REFERENCE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

interface ReferenceImage {
  data: string;
  mimeType: string;
  source: string;
}

interface ImageGenerationOptions {
  imageModel: (typeof IMAGE_MODELS)[number];
  quality?: (typeof IMAGE_QUALITIES)[number];
  size?: string;
  background?: (typeof IMAGE_BACKGROUNDS)[number];
  outputCompression?: number;
}

const TOOL_PARAMS = Type.Object({
  prompt: Type.String({ description: 'Prompt describing the image to generate or the edit to apply.' }),
  routerModel: Type.Optional(Type.String({
    description: `Codex controller model. Normally omit this to use ${DEFAULT_ROUTER_MODEL}; never use gpt-image-* here.`,
  })),
  imageModel: Type.Optional(StringEnum(IMAGE_MODELS, {
    description: `${DEFAULT_IMAGE_MODEL} (default) prioritizes editing precision; gpt-image-2.5-flare prioritizes speed.`,
  })),
  quality: Type.Optional(StringEnum(IMAGE_QUALITIES, {
    description: 'Image rendering quality. Defaults to auto; xhigh and max are supported by both GPT Image 2.5 models.',
  })),
  size: Type.Optional(Type.String({
    description: 'Image dimensions as WIDTHxHEIGHT or auto. Dimensions must satisfy GPT Image 2.5 limits.',
  })),
  background: Type.Optional(StringEnum(IMAGE_BACKGROUNDS, {
    description: 'Image background mode supported by the Codex endpoint.',
  })),
  outputCompression: Type.Optional(Type.Integer({
    description: 'JPEG or WebP compression level from 0 to 100.',
    minimum: 0,
    maximum: 100,
  })),
  imagePaths: Type.Optional(Type.Array(Type.String({
    description: 'Local PNG, JPEG, WebP, or GIF reference-image path, resolved relative to the project.',
  }), {
    description: `Optional reference images for image-to-image generation or editing (maximum ${MAX_REFERENCE_IMAGES}).`,
    maxItems: MAX_REFERENCE_IMAGES,
  })),
  useAttachedImages: Type.Optional(Type.Boolean({
    description: 'Include images attached to the latest user message as references. Defaults to true.',
  })),
  outputFormat: Type.Optional(StringEnum(OUTPUT_FORMATS)),
  save: Type.Optional(StringEnum(SAVE_MODES)),
  saveDir: Type.Optional(Type.String()),
});

function isBackendImageModel(value: unknown): boolean {
  return typeof value === 'string' && /^gpt-image(?:-|$)/i.test(value.trim());
}

function normalizeRouterModel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || isBackendImageModel(value)) {
    return DEFAULT_ROUTER_MODEL;
  }
  return value.trim();
}

function prepareToolArguments(args: unknown): any {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const input = { ...(args as Record<string, unknown>) };

  // Compatibility with older sessions and callers. `model` used to be
  // ambiguous: GPT Image values belong on the image-generation tool, while all
  // other values select the Codex controller. Keep both routes unambiguous.
  const legacyModel = input.model;
  delete input.model;
  if (typeof legacyModel === 'string' && isBackendImageModel(legacyModel)) {
    const normalizedLegacyModel = legacyModel.trim().toLowerCase();
    if (input.imageModel === undefined && IMAGE_MODELS.includes(normalizedLegacyModel as (typeof IMAGE_MODELS)[number])) {
      input.imageModel = normalizedLegacyModel;
    }
  }
  const requestedRouter = input.routerModel ?? (isBackendImageModel(legacyModel) ? undefined : legacyModel);
  if (typeof requestedRouter === 'string' && requestedRouter.trim() && !isBackendImageModel(requestedRouter)) {
    input.routerModel = requestedRouter.trim();
  } else {
    delete input.routerModel;
  }

  // Accept the common singular spelling from hand-written pipelines without
  // weakening the public schema.
  if (typeof input.imagePath === 'string' && input.imagePaths === undefined) {
    input.imagePaths = [input.imagePath];
  }
  delete input.imagePath;
  return input;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('OpenAI Codex auth token is not a JWT. Run /login for openai-codex again.');
  }
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

function extractChatGptAccountId(token: string): string {
  const payload = decodeJwtPayload(token);
  const claims = payload[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
  const accountId = claims?.chatgpt_account_id;
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('OpenAI Codex auth token does not contain chatgpt_account_id. Run /login again.');
  }
  return accountId;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function loadConfig(cwd: string): Record<string, unknown> {
  const globalConfigDir = join(getAgentDir(), 'extensions');
  const projectConfigDir = join(cwd, CONFIG_DIR_NAME, 'extensions');
  return {
    // Keep reading the former filename so existing installations migrate
    // without a breaking configuration change.
    ...readJson(join(globalConfigDir, LEGACY_CONFIG_FILE_NAME)),
    ...readJson(join(globalConfigDir, CONFIG_FILE_NAME)),
    ...readJson(join(projectConfigDir, LEGACY_CONFIG_FILE_NAME)),
    ...readJson(join(projectConfigDir, CONFIG_FILE_NAME)),
  };
}

function safePathPart(value: unknown, fallback: string): string {
  const safe = String(value ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+$/g, '');
  return safe || fallback;
}

function enumOption<T extends readonly string[]>(
  value: unknown,
  options: T,
  name: string,
): T[number] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!options.includes(normalized as T[number])) {
    throw new Error(`Invalid ${name}: ${String(value)}. Expected one of: ${options.join(', ')}.`);
  }
  return normalized as T[number];
}

function imageSize(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'auto') return normalized;
  const match = /^(\d+)x(\d+)$/.exec(normalized);
  if (!match) throw new Error('Invalid size. Use auto or WIDTHxHEIGHT, for example 1536x1024.');
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = width / height;
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error('Invalid size: width and height must be multiples of 16.');
  }
  if (ratio < 1 / 3 || ratio > 3) {
    throw new Error('Invalid size: aspect ratio must be between 1:3 and 3:1.');
  }
  if (width > 3840 || height > 3840) {
    throw new Error('Invalid size: neither edge may exceed 3840 pixels.');
  }
  if (pixels < 655_360 || pixels > 8_294_400) {
    throw new Error('Invalid size: total pixel count must be between 655,360 and 8,294,400.');
  }
  return `${width}x${height}`;
}

function resolveImageOptions(
  params: Record<string, unknown>,
  config: Record<string, unknown>,
  outputFormat: string,
): ImageGenerationOptions {
  const legacyConfigModel = typeof config.model === 'string'
    ? config.model.trim().toLowerCase()
    : undefined;
  const legacyConfigImageModel = IMAGE_MODELS.includes(legacyConfigModel as (typeof IMAGE_MODELS)[number])
    ? legacyConfigModel
    : undefined;
  const imageModel = enumOption(
    params.imageModel ?? config.imageModel ?? legacyConfigImageModel ?? DEFAULT_IMAGE_MODEL,
    IMAGE_MODELS,
    'imageModel',
  ) ?? DEFAULT_IMAGE_MODEL;
  const quality = enumOption(params.quality ?? config.quality, IMAGE_QUALITIES, 'quality');
  const size = imageSize(params.size ?? config.size);
  const background = enumOption(params.background ?? config.background, IMAGE_BACKGROUNDS, 'background');
  const rawCompression = params.outputCompression ?? config.outputCompression;
  let outputCompression: number | undefined;
  if (rawCompression !== undefined && rawCompression !== null && rawCompression !== '') {
    outputCompression = Number(rawCompression);
    if (!Number.isInteger(outputCompression) || outputCompression < 0 || outputCompression > 100) {
      throw new Error('Invalid outputCompression: expected an integer from 0 to 100.');
    }
    if (outputFormat !== 'jpeg' && outputFormat !== 'webp') {
      throw new Error('outputCompression is only supported with JPEG or WebP output.');
    }
  }
  return { imageModel, quality, size, background, outputCompression };
}

function resolveSaveConfig(params: Record<string, unknown>, cwd: string, sessionId: string, config: Record<string, unknown>) {
  const envMode = process.env.PI_CODEX_IMAGE_SAVE_MODE?.toLowerCase();
  const mode = String(params.save || envMode || config.save || 'global');
  if (!SAVE_MODES.includes(mode as (typeof SAVE_MODES)[number])) {
    throw new Error(`Invalid save mode: ${mode}.`);
  }
  const safeSessionId = safePathPart(sessionId, 'session');
  if (mode === 'none') return { mode };
  if (mode === 'project') return { mode, outputDir: join(cwd, CONFIG_DIR_NAME, 'generated-images', safeSessionId) };
  if (mode === 'global') return { mode, outputDir: join(getAgentDir(), 'generated-images', safeSessionId) };

  const configuredDir = params.saveDir || process.env.PI_CODEX_IMAGE_SAVE_DIR || config.saveDir;
  if (typeof configuredDir !== 'string' || !configuredDir.trim()) {
    throw new Error('save=custom requires saveDir or PI_CODEX_IMAGE_SAVE_DIR.');
  }
  const absoluteDir = isAbsolute(configuredDir) ? configuredDir : resolve(cwd, configuredDir);
  return { mode, outputDir: join(absoluteDir, safeSessionId) };
}

function mimeForFormat(format: string): string {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
}

function mimeForReferencePath(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg':
    case '.jfif': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return undefined;
  }
}

function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

function validateReferenceImage(image: ReferenceImage): ReferenceImage {
  const mimeType = image.mimeType === 'image/jpg' ? 'image/jpeg' : image.mimeType.toLowerCase();
  if (!REFERENCE_IMAGE_MIMES.has(mimeType)) {
    throw new Error(`Unsupported reference image type ${image.mimeType} from ${image.source}. Use PNG, JPEG, WebP, or GIF.`);
  }
  if (!image.data) throw new Error(`Reference image ${image.source} is empty.`);
  const size = decodedBase64Bytes(image.data);
  if (size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`Reference image ${image.source} is too large (${size} bytes; maximum ${MAX_REFERENCE_IMAGE_BYTES}).`);
  }
  return { ...image, mimeType };
}

async function loadReferenceImagePath(rawPath: string, cwd: string): Promise<ReferenceImage> {
  const normalizedPath = rawPath.trim().replace(/^@/, '');
  if (!normalizedPath) throw new Error('Reference image path cannot be empty.');
  const absolutePath = isAbsolute(normalizedPath) ? normalizedPath : resolve(cwd, normalizedPath);
  const mimeType = mimeForReferencePath(absolutePath);
  if (!mimeType) {
    throw new Error(`Unsupported reference image extension: ${rawPath}. Use PNG, JPEG, WebP, or GIF.`);
  }
  const fileInfo = await stat(absolutePath);
  if (!fileInfo.isFile()) throw new Error(`Reference image is not a file: ${rawPath}.`);
  if (fileInfo.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`Reference image ${rawPath} is too large (${fileInfo.size} bytes; maximum ${MAX_REFERENCE_IMAGE_BYTES}).`);
  }
  const data = (await readFile(absolutePath)).toString('base64');
  return validateReferenceImage({ data, mimeType, source: absolutePath });
}

function latestUserAttachedImages(ctx: ExtensionContext): ReferenceImage[] {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    const message = entry?.type === 'message' ? entry.message : undefined;
    if (message?.role !== 'user') continue;
    if (!Array.isArray(message.content)) return [];
    return message.content
      .filter((part: any) => part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string')
      .map((part: any, imageIndex: number) => validateReferenceImage({
        data: part.data,
        mimeType: part.mimeType,
        source: `latest user attachment ${imageIndex + 1}`,
      }));
  }
  return [];
}

function deduplicateReferenceImages(images: ReferenceImage[]): ReferenceImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const digest = createHash('sha256').update(image.mimeType).update('\0').update(image.data).digest('hex');
    if (seen.has(digest)) return false;
    seen.add(digest);
    return true;
  });
}

async function resolveReferenceImages(
  params: Record<string, unknown>,
  cwd: string,
  ctx: ExtensionContext,
): Promise<ReferenceImage[]> {
  const rawPaths = Array.isArray(params.imagePaths)
    ? params.imagePaths.filter((path): path is string => typeof path === 'string')
    : [];
  const pathImages = await Promise.all(rawPaths.map((path) => loadReferenceImagePath(path, cwd)));
  const attachedImages = params.useAttachedImages === false ? [] : latestUserAttachedImages(ctx);
  const images = deduplicateReferenceImages([...pathImages, ...attachedImages]);
  if (images.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`Too many reference images (${images.length}); maximum ${MAX_REFERENCE_IMAGES}.`);
  }
  return images;
}

async function saveImage(base64: string, format: string, outputDir: string, id: string): Promise<string> {
  const extension = format === 'jpeg' ? 'jpg' : format;
  const path = join(outputDir, `${safePathPart(id, 'image_generation')}.${extension}`);
  await withFileMutationQueue(path, async () => {
    await mkdir(outputDir, { recursive: true });
    await writeFile(path, Buffer.from(base64, 'base64'));
  });
  return path;
}

class CodexHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'CodexHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/usage_limit_reached|safety system|moderation[_ -]?blocked|image_generation_user_error|not supported|invalid[_ -]?request|authentication|unauthori[sz]ed|forbidden/i.test(message)) {
    return false;
  }
  if (error instanceof CodexHttpError) {
    return error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return /\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|server[_ -]?error|internal[_ -]?server|processing your request|you can retry your request|temporar(?:y|ily)|rate.?limit|overload|service.?unavailable|upstream.?connect|connection.?refused|timeout|stream ended/i.test(message);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function backoffMs(attempt: number, error?: unknown): number {
  const exponential = BASE_DELAY_MS * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2);
  const retryAfter = error instanceof CodexHttpError ? error.retryAfterMs ?? 0 : 0;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(exponential, retryAfter));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Image generation was aborted.');
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      done();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Image generation was aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function outputTextFromItem(item: any): string {
  if (!Array.isArray(item?.content)) return '';
  return item.content
    .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('');
}

function inspectOutputItem(item: any, parsed: any): void {
  if (!item || typeof item !== 'object') return;
  if (item.type === 'image_generation_call') {
    if (typeof item.result === 'string' && item.result.length > 0) {
      parsed.image = {
        id: String(item.id || 'image_generation'),
        status: String(item.status || 'completed'),
        result: item.result,
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      };
    } else {
      parsed.imageFailure = {
        id: String(item.id || 'image_generation'),
        status: String(item.status || 'failed'),
        error: item.error,
      };
    }
  }
  if (item.type === 'message') {
    const text = outputTextFromItem(item);
    if (text) parsed.finalText = text;
  }
}

function handleCodexEvent(event: any, parsed: any): void {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'error') {
    throw new Error(`Codex error: ${event.message || event.code || JSON.stringify(event)}`);
  }
  if (event.type === 'response.failed') {
    throw new Error(event.response?.error?.message || 'Codex response failed.');
  }
  if (event.type === 'response.created' && typeof event.response?.id === 'string') {
    parsed.responseId = event.response.id;
  }
  if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
    parsed.text.push(event.delta);
  }
  if (event.type === 'response.output_item.done') {
    inspectOutputItem(event.item, parsed);
  }
  if (event.type === 'response.completed') {
    if (typeof event.response?.id === 'string') parsed.responseId = event.response.id;
    if (event.response?.usage) parsed.usage = event.response.usage;
    if (Array.isArray(event.response?.output)) {
      for (const item of event.response.output) inspectOutputItem(item, parsed);
    }
    if (event.response?.error) parsed.responseError = event.response.error;
  }
}

function parseSseBlock(block: string): string | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
    .trim();
  return data && data !== '[DONE]' ? data : undefined;
}

async function parseCodexSse(response: Response, signal?: AbortSignal): Promise<any> {
  if (!response.body) throw new Error('Codex response did not include a stream body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parsed = { text: [], finalText: '', image: undefined, imageFailure: undefined, responseId: undefined, usage: undefined } as any;
  let buffer = '';

  const consume = (block: string) => {
    const data = parseSseBlock(block);
    if (data) handleCodexEvent(JSON.parse(data), parsed);
  };

  try {
    while (true) {
      if (signal?.aborted) throw new Error('Image generation was aborted.');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) consume(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
    reader.releaseLock();
  }
  return parsed;
}

function buildRequestBody(
  params: Record<string, unknown>,
  routerModel: string,
  outputFormat: string,
  sessionId: string,
  referenceImages: ReferenceImage[],
  imageOptions: ImageGenerationOptions,
) {
  const content: any[] = [{ type: 'input_text', text: params.prompt }];
  for (const image of referenceImages) {
    content.push({
      type: 'input_image',
      detail: 'auto',
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  const imageTool = {
    type: 'image_generation',
    model: imageOptions.imageModel,
    output_format: outputFormat,
    ...(imageOptions.quality && { quality: imageOptions.quality }),
    ...(imageOptions.size && { size: imageOptions.size }),
    ...(imageOptions.background && { background: imageOptions.background }),
    ...(imageOptions.outputCompression !== undefined && { output_compression: imageOptions.outputCompression }),
  };
  return {
    model: routerModel,
    store: false,
    stream: true,
    prompt_cache_key: sessionId,
    instructions: referenceImages.length > 0
      ? 'You are generating or editing bitmap image assets. Use the supplied reference images as requested. Call image_generation exactly once. If it fails, explain the reason briefly.'
      : 'You are generating bitmap image assets. Call image_generation exactly once. If it fails, explain the reason briefly.',
    input: [{ role: 'user', content }],
    tools: [imageTool],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    text: { verbosity: 'low' },
  };
}

async function requestImage(
  params: Record<string, unknown>,
  token: string,
  accountId: string,
  routerModel: string,
  format: string,
  sessionId: string,
  referenceImages: ReferenceImage[],
  imageOptions: ImageGenerationOptions,
  signal?: AbortSignal,
  onRetry?: (nextAttempt: number, delayMs: number, reason: string) => void,
) {
  const body = JSON.stringify(buildRequestBody(params, routerModel, format, sessionId, referenceImages, imageOptions));
  const headers = {
    Authorization: `Bearer ${token}`,
    'chatgpt-account-id': accountId,
    originator: 'pi',
    'OpenAI-Beta': OPENAI_BETA_HEADER,
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      throwIfAborted(signal);
      const response = await fetch(CODEX_RESPONSES_URL, { method: 'POST', headers, body, signal });
      if (!response.ok) {
        const responseBody = await response.text();
        throw new CodexHttpError(
          response.status,
          `Codex image generation request failed (${response.status}): ${responseBody}`,
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }
      const parsed = await parseCodexSse(response, signal);
      parsed.attempts = attempt;
      if (parsed.image) return parsed;

      // A completed SSE response can still contain a transient failed
      // image_generation_call. Retry it here so pipelines see one tool call,
      // rather than an error followed by a second model-issued tool call.
      const backendFailure = new Error(backendFailureMessage(parsed));
      if (attempt > MAX_RETRIES || !isRetryable(backendFailure)) return parsed;
      const delayMs = backoffMs(attempt, backendFailure);
      onRetry?.(attempt + 1, delayMs, backendFailure.message);
      await waitForRetry(delayMs, signal);
    } catch (error) {
      throwIfAborted(signal);
      if (attempt > MAX_RETRIES || !isRetryable(error)) throw error;
      const delayMs = backoffMs(attempt, error);
      const reason = error instanceof Error ? error.message : String(error);
      onRetry?.(attempt + 1, delayMs, reason);
      await waitForRetry(delayMs, signal);
    }
  }
  throw new Error('Codex image generation request failed after all retries.');
}

function backendFailureMessage(parsed: any): string {
  const text = String(parsed.finalText || parsed.text.join('')).trim();
  const backendError = parsed.imageFailure?.error?.message || parsed.responseError?.message;
  const reason = String(backendError || text || '').trim();
  const status = parsed.imageFailure?.status ? ` (${parsed.imageFailure.status})` : '';
  return reason
    ? `Codex image generation failed${status}: ${reason}`
    : `Codex image generation failed${status} without a backend diagnostic.`;
}

export default function codexSubImagen(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'codex_generate_image',
    label: 'Codex Image',
    description: `Generate or edit bitmap images through Codex with GPT Image 2.5. ${DEFAULT_IMAGE_MODEL} is the default; Flare is optional for faster generation. Omit routerModel normally. Supports local imagePaths and latest-message image attachments as references.`,
    promptSnippet: 'Generate or edit bitmap images via Codex GPT Image 2.5, with optional reference images and output controls.',
    promptGuidelines: [
      'Call codex_generate_image without routerModel unless a Codex controller override is explicitly required; never pass a gpt-image-* value as routerModel.',
      'When the user provides reference-image files, pass them through codex_generate_image imagePaths. Images attached to the latest user message are included by default.',
    ],
    parameters: TOOL_PARAMS,
    prepareArguments: prepareToolArguments,
    executionMode: 'parallel',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const outputFormat = enumOption(
        params.outputFormat ?? config.outputFormat ?? 'png',
        OUTPUT_FORMATS,
        'outputFormat',
      ) ?? 'png';
      const imageOptions = resolveImageOptions(params, config, outputFormat);
      const requestedRouterModel = normalizeRouterModel(
        params.routerModel ?? config.routerModel ?? config.model ?? DEFAULT_ROUTER_MODEL,
      );
      const routerModel = ctx.modelRegistry.find(PROVIDER, requestedRouterModel)?.id || requestedRouterModel;
      const referenceImages = await resolveReferenceImages(params, ctx.cwd, ctx);
      const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
      if (!token) throw new Error(`Missing ${PROVIDER} credentials. Run /login again.`);

      const sessionId = ctx.sessionManager.getSessionId();
      const progressDetails = {
        provider: PROVIDER,
        routerModel,
        imageModel: imageOptions.imageModel,
        backendImageModel: imageOptions.imageModel,
        quality: imageOptions.quality ?? 'auto',
        size: imageOptions.size ?? 'auto',
        background: imageOptions.background ?? 'auto',
        outputFormat,
        outputCompression: imageOptions.outputCompression,
        referenceImageCount: referenceImages.length,
      };
      onUpdate?.({
        content: [{
          type: 'text',
          text: `Requesting ${imageOptions.imageModel} through ${PROVIDER}/${routerModel}${referenceImages.length ? ` with ${referenceImages.length} reference image(s)` : ''}...`,
        }],
        details: progressDetails,
      });

      const parsed = await requestImage(
        params,
        token,
        extractChatGptAccountId(token),
        routerModel,
        outputFormat,
        sessionId,
        referenceImages,
        imageOptions,
        signal,
        (nextAttempt, delayMs, reason) => onUpdate?.({
          content: [{
            type: 'text',
            text: `Transient Codex failure; retrying internally (attempt ${nextAttempt}/${MAX_RETRIES + 1}) in ${(delayMs / 1000).toFixed(1)}s...`,
          }],
          details: { ...progressDetails, retryReason: reason.slice(0, 500), nextAttempt },
        }),
      );
      if (!parsed.image) throw new Error(backendFailureMessage(parsed));

      const saveConfig = resolveSaveConfig(params, ctx.cwd, sessionId, config);
      const savedPath = saveConfig.outputDir
        ? await saveImage(parsed.image.result, outputFormat, saveConfig.outputDir, parsed.image.id || toolCallId)
        : undefined;
      const summary = savedPath ? `Generated image and saved it to: ${savedPath}` : 'Generated image.';

      return {
        content: [
          { type: 'text', text: summary },
          { type: 'image', data: parsed.image.result, mimeType: mimeForFormat(outputFormat) },
        ],
        details: {
          provider: PROVIDER,
          model: routerModel,
          routerModel,
          imageModel: imageOptions.imageModel,
          backendImageModel: imageOptions.imageModel,
          quality: imageOptions.quality ?? 'auto',
          size: imageOptions.size ?? 'auto',
          background: imageOptions.background ?? 'auto',
          outputFormat,
          outputCompression: imageOptions.outputCompression,
          referenceImageCount: referenceImages.length,
          referenceImageSources: referenceImages.map((image) => image.source),
          attempts: parsed.attempts,
          saveMode: saveConfig.mode,
          savedPath,
          responseId: parsed.responseId,
          imageGenerationId: parsed.image.id,
          revisedPrompt: parsed.image.revisedPrompt,
          usage: parsed.usage,
        },
      };
    },
  });
}

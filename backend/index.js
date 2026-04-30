"use strict";

const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL_NAME = "glm-4v-flash";
const TRANSLATION_MODEL_NAME = process.env.ZHIPU_TRANSLATION_MODEL || "glm-4-flash-250414";
const TRANSLATION_CHUNK_SIZE = parsePositiveInt(process.env.ZHIPU_TRANSLATION_CHUNK_SIZE, 8);
const MAX_REMOTE_IMAGE_BYTES = 5 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000);
const RATE_LIMIT_MAX_REQUESTS = parsePositiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 30);
const RATE_LIMIT_DISABLED = String(process.env.RATE_LIMIT_DISABLED || "").toLowerCase() === "true";

const requestBuckets = new Map();
let requestCounter = 0;

const SCENE_TYPES = ["character", "object", "vehicle", "architecture", "interior", "landscape", "poster"];

const STYLE_TAXONOMY = {
  medium: ["photo", "illustration", "painting", "3d", "vector", "pixel_art"],
  renderStyle: ["realistic", "stylized", "anime", "doll_like", "cel_shaded", "painterly", "cgi"],
  aesthetic: ["cute", "minimal", "dreamy", "cinematic", "fashion", "retro", "cyberpunk", "fantasy"],
  lighting: ["soft", "studio", "natural", "dramatic", "cool_tone", "warm_tone"],
  composition: ["portrait", "bust_shot", "centered", "close_up", "front_view", "full_body", "wide_shot"],
  material: ["smooth", "glossy", "matte", "fabric_detail", "skin_detail", "painterly_texture"]
};

const CHARACTER_STYLE_HINTS = [
  "cyborg",
  "android",
  "robotic",
  "robotic armor",
  "mechanical arm",
  "mechanical details",
  "cybernetic",
  "mecha",
  "sci-fi character design",
  "futuristic mask"
];

const TAG_TRANSLATIONS = {
  anime: "动漫",
  manga: "漫画",
  illustration: "插画",
  "digital art": "数字艺术",
  stylized: "风格化",
  "stylized 3d": "风格化 3D",
  "stylized character": "风格化角色",
  doll: "人偶感",
  "doll-like": "人偶感",
  "3d": "3D",
  photo: "摄影",
  painting: "绘画",
  vector: "矢量",
  pixel_art: "像素风",
  "3d rendering": "3D 渲染",
  render: "渲染",
  rendering: "渲染",
  realistic: "写实",
  realism: "写实",
  cute: "可爱",
  dreamy: "梦幻",
  cinematic: "电影感",
  soft: "柔和",
  studio: "棚拍",
  natural: "自然光",
  dramatic: "戏剧光",
  cool_tone: "冷调",
  warm_tone: "暖调",
  bust_shot: "胸像",
  close_up: "特写",
  front_view: "正面",
  full_body: "全身",
  wide_shot: "广角",
  smooth: "平滑",
  glossy: "光泽",
  matte: "哑光",
  fabric_detail: "布料细节",
  skin_detail: "皮肤细节",
  painterly_texture: "笔触质感",
  cgi: "CGI",
  cartoon: "卡通",
  character: "角色",
  girl: "女孩",
  female: "女性",
  boy: "男孩",
  male: "男性",
  portrait: "人像",
  hoodie: "连帽衫",
  white: "白色",
  "white hair": "白发",
  "blue eyes": "蓝眼睛",
  cheeks: "脸颊",
  "pink cheeks": "粉色脸颊",
  background: "背景",
  studio: "棚拍背景",
  "clean background": "干净背景",
  "soft lighting": "柔光",
  "high detail": "高细节"
};

const SCENE_TYPE_TRANSLATIONS = {
  character: "人物",
  object: "物体",
  vehicle: "交通工具",
  architecture: "建筑",
  interior: "室内",
  landscape: "风景",
  poster: "海报"
};

exports.handler = async (input, second, third) => {
  if (isLegacyHttpHandler(second)) {
    return handleLegacyHttp(input, second);
  }

  return handleFc3Event(input, second, third);
};

async function handleLegacyHttp(req, resp) {
  try {
    const result = await routeRequest({
      method: req.method,
      path: req.path || req.url || "/",
      headers: normalizeHeaderKeys(req.headers || {}),
      bodyBuffer: toBuffer(req.body)
    });

    writeLegacyResponse(resp, result);
  } catch (error) {
    console.error(error);
    writeLegacyResponse(
      resp,
      jsonResponse(error.statusCode || 500, { error: error.message || "Internal server error" })
    );
  }
}

async function handleFc3Event(event, _context, callback) {
  try {
    const eventObject = parseFc3Event(event);
    const result = await routeRequest({
      method: eventObject?.requestContext?.http?.method || eventObject?.httpMethod || "GET",
      path:
        eventObject?.rawPath ||
        eventObject?.requestContext?.http?.path ||
        eventObject?.path ||
        "/",
      headers: normalizeHeaderKeys(eventObject?.headers || {}),
      bodyBuffer: decodeEventBody(eventObject)
    });

    const responsePayload = {
      isBase64Encoded: false,
      statusCode: result.statusCode,
      headers: result.headers,
      body: result.body
    };

    if (typeof callback === "function") {
      callback(null, responsePayload);
      return;
    }

    return responsePayload;
  } catch (error) {
    console.error(error);
    const failurePayload = {
      isBase64Encoded: false,
      statusCode: error.statusCode || 500,
      headers: defaultResponseHeaders(),
      body: JSON.stringify({ error: error.message || "Internal server error" })
    };

    if (typeof callback === "function") {
      callback(null, failurePayload);
      return;
    }

    return failurePayload;
  }
}

async function routeRequest(request) {
  const normalizedPath = normalizePath(request.path);

  if (request.method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: defaultResponseHeaders(),
      body: ""
    };
  }

  if (request.method === "GET" && (normalizedPath === "/" || pathMatches(normalizedPath, "/health"))) {
    return jsonResponse(200, {
      ok: true,
      service: "image-prompt-reverse-backend",
      now: new Date().toISOString(),
      rateLimit: {
        enabled: !RATE_LIMIT_DISABLED,
        windowMs: RATE_LIMIT_WINDOW_MS,
        maxRequests: RATE_LIMIT_MAX_REQUESTS
      }
    });
  }

  if (request.method !== "POST") {
    return jsonResponse(404, { error: "Not found" });
  }

  requireToken(request.headers);
  enforceRateLimit(request.headers);

  if (pathMatches(normalizedPath, "/api/translate-prompts")) {
    const body = parseJsonBody(request.bodyBuffer);
    const translated = await handleTranslatePrompts(body);
    return jsonResponse(200, translated);
  }

  const body = parseJsonBody(request.bodyBuffer);
  const imageInput = await resolveImageInput(body);
  const metadata = extractPromptMetadata(imageInput.buffer, imageInput.mimeType);

  if (metadata) {
    return jsonResponse(200, await buildMetadataResult(metadata));
  }

  const aiResult = await analyzeImageWithGlm(imageInput.dataUrl);
  return jsonResponse(200, {
    source: MODEL_NAME,
    ...aiResult
  });
}

async function handleTranslatePrompts(body) {
  const promptText = String(body.promptText || "").trim();
  const negativePrompt = String(body.negativePrompt || "").trim();
  if (promptText) {
    return buildLocalizedSinglePrompt(promptText, negativePrompt);
  }

  const promptModes = normalizeIncomingPromptModes(body.promptModes);
  const promptVariants = normalizeIncomingPromptVariants(body.promptVariants, promptModes);
  return buildLocalizedPromptBundle(promptModes, promptVariants, negativePrompt);
}

function enforceRateLimit(headers) {
  if (RATE_LIMIT_DISABLED || RATE_LIMIT_MAX_REQUESTS <= 0) {
    return;
  }

  requestCounter += 1;
  if (requestCounter % 50 === 0) {
    pruneExpiredBuckets();
  }

  const now = Date.now();
  const key = getClientKey(headers);
  const bucket = requestBuckets.get(key);

  if (!bucket || bucket.expiresAt <= now) {
    requestBuckets.set(key, {
      count: 1,
      expiresAt: now + RATE_LIMIT_WINDOW_MS
    });
    return;
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000));
    const error = new Error(`Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`);
    error.statusCode = 429;
    throw error;
  }

  bucket.count += 1;
}

function pruneExpiredBuckets() {
  const now = Date.now();
  for (const [key, bucket] of requestBuckets.entries()) {
    if (bucket.expiresAt <= now) {
      requestBuckets.delete(key);
    }
  }
}

function getClientKey(headers) {
  const forwarded = String(headers["x-forwarded-for"] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)[0];
  const realIp = String(headers["x-real-ip"] || "").trim();
  const fcClientIp = String(headers["x-fc-client-ip"] || "").trim();
  const ua = String(headers["user-agent"] || "unknown");

  return forwarded || realIp || fcClientIp || `ua:${ua}`;
}

async function buildMetadataResult(metadata) {
  const prompt = metadata.prompt || "";
  const negativePrompt = metadata.negativePrompt || "";
  const promptModes = {
    detailed: prompt,
    pro: prompt
  };
  const promptVariants = buildPromptVariantMatrix(promptModes);
  const styleProfile = emptyStyleProfile();

  return {
    source: "server-metadata",
    confidence: 1,
    prompt,
    negativePrompt,
    sceneType: "object",
    sceneTypeLabel: SCENE_TYPE_TRANSLATIONS.object,
    styleTags: [],
    subjectTags: [],
    reasoning: "已直接从图片元数据中提取到提示词，结果比纯视觉反推更接近原始生成参数。",
    styleProfile,
    promptModes,
    promptVariants,
    ...emptyLocalizedPromptBundle(),
    metadata
  };
}

function emptyLocalizedPromptBundle() {
  return {
    localizedPromptModes: null,
    localizedPromptVariants: null,
    localizedNegativePrompt: ""
  };
}

function writeLegacyResponse(resp, result) {
  for (const [key, value] of Object.entries(result.headers)) {
    resp.setHeader(key, value);
  }
  resp.setStatusCode(result.statusCode);
  resp.send(result.body);
}

function requireToken(headers) {
  const configuredToken = process.env.APP_TOKEN;
  if (!configuredToken || configuredToken === "__NONE__") {
    return;
  }

  const token = headers["x-app-token"];
  if (token !== configuredToken) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

function parseJsonBody(bodyBuffer) {
  if (!bodyBuffer || bodyBuffer.length === 0) {
    throw badRequest("Request body is required");
  }

  try {
    return JSON.parse(bodyBuffer.toString("utf8"));
  } catch (_error) {
    throw badRequest("Invalid JSON body");
  }
}

async function resolveImageInput(body) {
  if (typeof body.imageBase64 === "string" && body.imageBase64.trim()) {
    return parseImageBase64(body.imageBase64.trim());
  }

  if (typeof body.imageUrl === "string" && body.imageUrl.trim()) {
    return fetchRemoteImage(body.imageUrl.trim());
  }

  throw badRequest("Either imageUrl or imageBase64 is required");
}

function parseImageBase64(value) {
  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw badRequest("imageBase64 must be a valid data URL");
  }

  const mimeType = match[1];
  const buffer = Buffer.from(match[2], "base64");
  return {
    mimeType,
    buffer,
    dataUrl: value
  };
}

async function fetchRemoteImage(imageUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch (_error) {
    throw badRequest("imageUrl is not a valid URL");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw badRequest("imageUrl protocol must be http or https");
  }

  const response = await fetch(parsedUrl, {
    headers: {
      "User-Agent": "PromptReverseMVP/0.1"
    }
  });

  if (!response.ok) {
    const error = new Error(`Failed to fetch remote image: ${response.status}`);
    error.statusCode = 400;
    throw error;
  }

  const mimeType = response.headers.get("content-type") || "application/octet-stream";
  if (!mimeType.startsWith("image/")) {
    throw badRequest("imageUrl did not return an image");
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_REMOTE_IMAGE_BYTES) {
    throw badRequest("Remote image is too large");
  }

  return {
    mimeType,
    buffer,
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`
  };
}

function extractPromptMetadata(buffer, mimeType) {
  if (!buffer || !buffer.length) {
    return null;
  }

  if (mimeType.includes("png") && isPng(buffer)) {
    return extractPngMetadata(buffer);
  }

  return null;
}

function isPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return buffer.subarray(0, 8).equals(signature);
}

function extractPngMetadata(buffer) {
  let offset = 8;
  const textEntries = [];

  while (offset + 8 < buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;

    if (dataEnd > buffer.length) {
      break;
    }

    if (chunkType === "tEXt") {
      const raw = buffer.subarray(dataStart, dataEnd).toString("latin1");
      const separatorIndex = raw.indexOf("\0");
      if (separatorIndex > -1) {
        textEntries.push({
          key: raw.slice(0, separatorIndex),
          value: raw.slice(separatorIndex + 1)
        });
      }
    }

    offset = dataEnd + 4;
  }

  const parametersEntry = textEntries.find((entry) => /parameters/i.test(entry.key));
  if (!parametersEntry) {
    return null;
  }

  return parseStableDiffusionParameters(parametersEntry.value);
}

function parseStableDiffusionParameters(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const negativeIndex = lines.findIndex((line) => /^Negative prompt:/i.test(line));
  const prompt = negativeIndex === -1 ? lines[0] || "" : lines.slice(0, negativeIndex).join(", ");
  const negativePrompt =
    negativeIndex === -1 ? "" : lines[negativeIndex].replace(/^Negative prompt:\s*/i, "");

  return {
    prompt,
    negativePrompt,
    raw: text
  };
}

async function analyzeImageWithGlm(dataUrl) {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    const error = new Error("ZHIPU_API_KEY is not configured");
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(ZHIPU_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      temperature: 0.25,
      max_tokens: 900,
      messages: [
        {
          role: "system",
          content:
            "You are an image-to-prompt engine for AI art generation. " +
            "Return strict JSON only, no markdown fences, no explanations outside JSON."
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUrl }
            },
            {
              type: "text",
              text:
                "Analyze this image and reconstruct AI-generation prompts in two density levels. " +
                "Return strict JSON with keys: sceneType, detailedPrompt, proPrompt, negativePrompt, styleTags, subjectTags, styleProfile, reasoning, confidence. " +
                `sceneType must be one of: ${SCENE_TYPES.join(", ")}. ` +
                "All prompt fields must be English generation-ready prompts, not plain captions. " +
                "detailedPrompt should be 40 to 80 English words and include subject, art style, rendering or medium, colors, outfit, background, framing or composition, lighting, and quality detail. " +
                "proPrompt should be 70 to 140 English words and can include richer material, facial, lens, atmosphere, rendering, and lighting details when visually justified. " +
                "negativePrompt must be an English comma-separated string and must not conflict with the detected style. " +
                "If the image is anime, 3D, digital art, illustration, or cartoon-like, do not negate those traits. " +
                "styleTags and subjectTags must be short English arrays. " +
                "styleProfile must be an object with categories medium, renderStyle, aesthetic, lighting, composition, material. " +
                "Each category must be an array of 0 to 3 objects, each object has label and score. " +
                `Allowed labels are: medium=${STYLE_TAXONOMY.medium.join("|")}; ` +
                `renderStyle=${STYLE_TAXONOMY.renderStyle.join("|")}; ` +
                `aesthetic=${STYLE_TAXONOMY.aesthetic.join("|")}; ` +
                `lighting=${STYLE_TAXONOMY.lighting.join("|")}; ` +
                `composition=${STYLE_TAXONOMY.composition.join("|")}; ` +
                `material=${STYLE_TAXONOMY.material.join("|")}. ` +
                "Only use those labels. Scores must be between 0 and 1. " +
                "reasoning must be concise Chinese, natural and easy to read. " +
                "confidence must be a number between 0 and 1."
            }
          ]
        }
      ]
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || "GLM request failed");
    error.statusCode = 502;
    throw error;
  }

  const contentText = normalizeModelContent(payload.choices?.[0]?.message?.content);
  if (!contentText) {
    throw new Error("GLM response did not include content");
  }

  const parsed = parseModelJson(contentText);
  if (!parsed) {
    const fallbackModes = buildPromptModesFromSinglePrompt(contentText, [], []);
    const fallbackVariants = buildPromptVariantMatrix(fallbackModes);
    return {
      prompt: fallbackModes.detailed,
      negativePrompt: "blurry, low quality, bad anatomy, extra fingers, distorted face",
      sceneType: "object",
      sceneTypeLabel: SCENE_TYPE_TRANSLATIONS.object,
      styleTags: [],
      subjectTags: [],
      styleProfile: emptyStyleProfile(),
      reasoning: "模型返回了非结构化文本，已直接回传原始结果。",
      confidence: 0.4,
      promptModes: fallbackModes,
      promptVariants: fallbackVariants,
      ...emptyLocalizedPromptBundle()
    };
  }

  const rawPromptTexts = [
    parsed.detailedPrompt,
    parsed.proPrompt,
    parsed.prompt
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  const baseStyleProfile = normalizeStyleProfile(parsed.styleProfile, rawPromptTexts);
  const rawSubjectTagsEn = ensureStringArray(parsed.subjectTags);
  const sceneType = normalizeSceneType(parsed.sceneType, rawSubjectTagsEn, rawPromptTexts, baseStyleProfile);
  const subjectTagsEn = deriveSubjectTags(rawSubjectTagsEn, rawPromptTexts, sceneType);
  const styleProfile = adaptStyleProfileForScene(baseStyleProfile, sceneType, rawPromptTexts);
  const styleTagsEn = deriveStyleTags(
    styleProfile,
    ensureStringArray(parsed.styleTags),
    rawPromptTexts,
    sceneType
  );
  const promptModes = buildPromptModes(parsed, styleTagsEn, subjectTagsEn, styleProfile, sceneType);
  const negativePrompt = sanitizeNegativePrompt(
    String(parsed.negativePrompt || ""),
    sceneType,
    styleTagsEn,
    subjectTagsEn,
    Object.values(promptModes)
  );
  const reasoning = normalizeReasoning(String(parsed.reasoning || ""), styleTagsEn, subjectTagsEn);
  const promptVariants = buildPromptVariantMatrix(promptModes);

  return {
    prompt: promptModes.detailed,
    negativePrompt,
    sceneType,
    sceneTypeLabel: SCENE_TYPE_TRANSLATIONS[sceneType] || sceneType,
    styleTags: localizeTags(styleTagsEn),
    subjectTags: localizeTags(subjectTagsEn),
    styleProfile: localizeStyleProfile(styleProfile),
    styleTagsEn,
    subjectTagsEn,
    reasoning,
    confidence: normalizeConfidence(parsed.confidence),
    promptModes,
    promptVariants,
    ...emptyLocalizedPromptBundle()
  };
}

function normalizeModelContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item.text === "string") {
          return item.text;
        }
        if (item && typeof item.content === "string") {
          return item.content;
        }
        return "";
      })
      .join("\n")
      .trim();
  }

  if (content && typeof content.text === "string") {
    return content.text.trim();
  }

  return "";
}

function parseModelJson(text) {
  const cleaned = stripCodeFence(text);
  const direct = parseJsonSafely(cleaned);
  if (direct) {
    return direct;
  }

  const extractedObject = extractBalancedJsonObject(cleaned);
  if (extractedObject) {
    const extractedDirect = parseJsonSafely(extractedObject);
    if (extractedDirect) {
      return extractedDirect;
    }

    const looseParsed = parseJsonLoosely(extractedObject);
    if (looseParsed) {
      return looseParsed;
    }
  }

  const looseWhole = parseJsonLoosely(cleaned);
  if (looseWhole) {
    return looseWhole;
  }

  return salvageModelJson(cleaned);
}

function stripCodeFence(text) {
  return String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function parseJsonLoosely(text) {
  const normalized = String(text || "")
    .replace(/^\s*```json\s*/i, "")
    .replace(/^\s*```\s*/i, "")
    .replace(/\s*```$/g, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s*=>\s*/g, ": ")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();

  return parseJsonSafely(normalized);
}

function extractBalancedJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start === -1) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return source.slice(start);
}

function salvageModelJson(text) {
  const source = String(text || "");
  const result = {};

  for (const key of [
    "sceneType",
    "concisePrompt",
    "detailedPrompt",
    "proPrompt",
    "prompt",
    "negativePrompt",
    "reasoning"
  ]) {
    const value = extractJsonLikeString(source, key);
    if (value) {
      result[key] = value;
    }
  }

  const confidence = extractJsonLikeNumber(source, "confidence");
  if (confidence != null) {
    result.confidence = confidence;
  }

  const styleTags = extractJsonLikeStringArray(source, "styleTags");
  if (styleTags.length) {
    result.styleTags = styleTags;
  }

  const subjectTags = extractJsonLikeStringArray(source, "subjectTags");
  if (subjectTags.length) {
    result.subjectTags = subjectTags;
  }

  const styleProfile = extractJsonLikeObject(source, "styleProfile");
  if (styleProfile) {
    result.styleProfile = styleProfile;
  }

  const hasPrompt =
    Boolean(result.concisePrompt) ||
    Boolean(result.detailedPrompt) ||
    Boolean(result.proPrompt) ||
    Boolean(result.prompt);

  return hasPrompt ? result : null;
}

function extractJsonLikeString(source, key) {
  const match = String(source || "").match(
    new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s")
  );

  if (!match) {
    return "";
  }

  return match[1]
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJsonLikeNumber(source, key) {
  const match = String(source || "").match(
    new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`, "s")
  );

  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractJsonLikeStringArray(source, key) {
  const match = String(source || "").match(
    new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, "s")
  );

  if (!match) {
    return [];
  }

  return dedupeStrings(
    Array.from(match[1].matchAll(/"((?:\\.|[^"\\])*)"/g)).map((item) =>
      item[1].replace(/\\"/g, "\"").trim()
    )
  );
}

function extractJsonLikeObject(source, key) {
  const match = String(source || "").match(
    new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*(\\{[\\s\\S]*\\})`, "s")
  );

  if (!match) {
    return null;
  }

  const objectText = extractBalancedJsonObject(match[1]);
  if (!objectText) {
    return null;
  }

  return parseJsonLoosely(objectText);
}

function ensureStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeStrings(value.map((item) => String(item || "").trim()).filter(Boolean));
}

function enrichPrompt(prompt, styleTags, subjectTags, styleProfile, sceneType) {
  const cleanedPrompt = sanitizePromptSeed(prompt, sceneType);
  const lowerPrompt = cleanedPrompt.toLowerCase();
  const additions = [];

  additions.push(...buildPromptStylePhrases(styleProfile, styleTags, lowerPrompt, sceneType));

  if (cleanedPrompt.split(/\s+/).length < 16) {
    additions.push(...subjectTags.filter((tag) => !lowerPrompt.includes(tag.toLowerCase())).slice(0, 4));
  }

  if (!/\b(background|scene|studio|environment|harbor|port|interior|landscape|poster)\b/i.test(cleanedPrompt)) {
    additions.push(defaultBackgroundPhrase(sceneType));
  }

  if (!/\b(light|lighting|lit|glow)\b/i.test(cleanedPrompt)) {
    additions.push("soft even lighting");
  }

  if (!/\b(detail|detailed|high detail|highly detailed|sharp)\b/i.test(cleanedPrompt)) {
    additions.push("high detail");
  }

  if (!/\b(portrait|close-up|medium shot|upper body|full body|isometric|front view|scene|composition|bust)\b/i.test(cleanedPrompt)) {
    additions.push(defaultCompositionPhrase(sceneType, styleProfile));
  }

  return [cleanedPrompt, ...dedupeStrings(additions)]
    .filter(Boolean)
    .join(", ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPromptModes(parsed, styleTags, subjectTags, styleProfile, sceneType) {
  const detailedSeed = String(parsed.detailedPrompt || parsed.prompt || parsed.concisePrompt || "").trim();
  const proSeed =
    String(parsed.proPrompt || parsed.detailedPrompt || parsed.prompt || detailedSeed).trim();

  const detailed = finalizePromptText(enrichPrompt(detailedSeed, styleTags, subjectTags, styleProfile, sceneType), sceneType);
  const pro = finalizePromptText(enrichProfessionalPrompt(proSeed, styleTags, subjectTags, styleProfile, sceneType), sceneType);

  return {
    detailed,
    pro
  };
}

function buildPromptModesFromSinglePrompt(prompt, styleTags, subjectTags) {
  const styleProfile = emptyStyleProfile();
  const sceneType = "object";
  const detailed = finalizePromptText(
    enrichPrompt(String(prompt || ""), styleTags, subjectTags, styleProfile, sceneType),
    sceneType
  );
  return {
    detailed,
    pro: finalizePromptText(
      enrichProfessionalPrompt(detailed, styleTags, subjectTags, styleProfile, sceneType),
      sceneType
    )
  };
}

function tightenPrompt(prompt, maxWords) {
  const words = String(prompt || "").replace(/\s+/g, " ").trim().split(" ");
  if (words.length <= maxWords) {
    return String(prompt || "").trim();
  }

  return words.slice(0, maxWords).join(" ").replace(/[,\s]+$/g, "");
}

function finalizePromptText(prompt, sceneType) {
  const cleaned = sanitizePromptSeed(prompt, sceneType)
    .replace(/\b[Aa]n?\s+/g, (match, offset) => (offset === 0 ? "" : match))
    .replace(/\bher pose is\b/gi, "")
    .replace(/\bhis pose is\b/gi, "")
    .replace(/\bthe pose is\b/gi, "")
    .replace(/\bthe outfit includes\b/gi, "")
    .replace(/\blighting highlights\b/gi, "lighting highlighting")
    .replace(/\bcreating a dramatic effect\b/gi, "dramatic mood")
    .replace(/\bcreating\b/gi, "")
    .replace(/\bcapturing\b/gi, "")
    .replace(/\bset against\b/gi, "against")
    .replace(/\bshowcasing\b/gi, "")
    .replace(/\bincludes\b/gi, "")
    .replace(/\bwith her\b/gi, "with")
    .replace(/\bwith his\b/gi, "with")
    .replace(/\bwith the\b/gi, "with")
    .replace(/\s+,/g, ",")
    .replace(/,{2,}/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();

  const rawParts = cleaned
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const dedupedParts = dedupePromptParts(rawParts);
  return dedupedParts.join(", ").replace(/\s+/g, " ").trim().replace(/[,\s]+$/g, "");
}

function dedupePromptParts(parts) {
  const accepted = [];
  const canonicalParts = [];

  for (const part of parts) {
    const canonical = canonicalizePromptPart(part);
    if (!canonical) {
      continue;
    }

    const exactIndex = canonicalParts.indexOf(canonical);
    if (exactIndex !== -1) {
      continue;
    }

    const overlappingIndex = canonicalParts.findIndex((existing) =>
      existing === canonical ||
      existing.includes(canonical) ||
      canonical.includes(existing)
    );

    if (overlappingIndex === -1) {
      accepted.push(part);
      canonicalParts.push(canonical);
      continue;
    }

    if (canonical.length > canonicalParts[overlappingIndex].length) {
      accepted[overlappingIndex] = part;
      canonicalParts[overlappingIndex] = canonical;
    }
  }

  return accepted;
}

function canonicalizePromptPart(part) {
  return String(part || "")
    .toLowerCase()
    .replace(/\b(rendered in|rendered with|wearing|against|with)\b/g, "")
    .replace(/\b(aesthetic|style|design|detailing|details|quality|render)\b/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function enrichProfessionalPrompt(prompt, styleTags, subjectTags, styleProfile, sceneType) {
  const detailed = enrichPrompt(prompt, styleTags, subjectTags, styleProfile, sceneType);
  const lower = detailed.toLowerCase();
  const additions = [];

  if (sceneType === "character" && !/\b(face|expression|eyes|skin|eyelashes|makeup)\b/.test(lower)) {
    additions.push("clear facial features");
  }
  if (!/\b(texture|fabric|material|surface)\b/.test(lower)) {
    additions.push("clean material definition");
  }
  if (!/\b(cinematic|octane|render|studio|global illumination)\b/.test(lower)) {
    additions.push("polished render quality");
  }
  if (!/\b(atmosphere|mood|tone)\b/.test(lower)) {
    additions.push("soft fresh atmosphere");
  }
  if (
    sceneType === "character" &&
    /\b(cyborg|android|cybernetic|robotic|mechanical|mecha|sci-fi|cyberpunk)\b/.test(lower) &&
    !/\b(cyberpunk aesthetic|sci-fi character design|mecha-inspired)\b/.test(lower)
  ) {
    additions.push("cyberpunk aesthetic", "sci-fi character design", "mecha-inspired detailing");
  }
  if (sceneType === "vehicle" && !/\b(isometric|industrial|dock|harbor|geometry)\b/.test(lower)) {
    additions.push("clean industrial scene");
  }
  if (sceneType === "architecture" && !/\b(structure|architectural|facade|space)\b/.test(lower)) {
    additions.push("architectural visualization");
  }
  if (sceneType === "object" && !/\b(product|object|design|shape)\b/.test(lower)) {
    additions.push("clean product-style presentation");
  }
  if (
    sceneType === "object" &&
    /\b(cloud|dashboard|analytics|data visualization|bar chart|pie chart|chart|graph|tablet|screen|interface)\b/.test(lower)
  ) {
    if (!/\bcloud computing concept\b/.test(lower)) {
      additions.push("cloud computing concept");
    }
    if (!/\bdata visualization elements\b/.test(lower)) {
      additions.push("data visualization elements");
    }
    if (!/\bproduct showcase\b/.test(lower)) {
      additions.push("minimal product showcase");
    }
  }

  return [detailed, ...dedupeStrings(additions)]
    .filter(Boolean)
    .join(", ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeNegativePrompt(negativePrompt, sceneType, styleTags, subjectTags, promptTexts) {
  const styleText = styleTags.join(" ").toLowerCase();
  const blockedTerms = [];
  const protectedTerms = buildProtectedTerms(subjectTags, promptTexts);
  const qualityTerms = [];

  if (/\banime\b/.test(styleText)) {
    blockedTerms.push("anime", "cartoon", "manga");
  }
  if (/\b3d\b|\brender\b|\brendering\b/.test(styleText)) {
    blockedTerms.push("3d", "render", "rendering", "cgi");
  }
  if (/\bdigital art\b|\billustration\b/.test(styleText)) {
    blockedTerms.push("digital art", "illustration");
  }
  if (/\bstylized\b|\bdoll\b/.test(styleText)) {
    blockedTerms.push("stylized", "doll", "toy-like");
  }
  if (/\brealism\b/.test(styleText) && /\banime\b|\b3d\b/.test(styleText)) {
    blockedTerms.push("realism", "realistic");
  }

  const rawParts = negativePrompt.trim() ? negativePrompt.split(/[,，]/) : [];
  const filtered = rawParts
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      const lower = item.toLowerCase();
      if (blockedTerms.some((term) => lower.includes(term))) {
        return false;
      }

      if (protectedTerms.some((term) => lower.includes(term))) {
        return false;
      }

      if (/^no\s+/.test(lower) || /^without\s+/.test(lower)) {
        return false;
      }

      if (isHighValueNegativeTerm(lower, sceneType)) {
        qualityTerms.push(lower);
      }

      return false;
    });

  return dedupeStrings([
    ...qualityTerms,
    ...defaultNegativeTerms(sceneType)
  ]).join(", ");
}

function normalizeReasoning(reasoning, styleTags, subjectTags) {
  const cleaned = reasoning.replace(/\s+/g, " ").trim();
  if (containsChinese(cleaned)) {
    return cleaned;
  }

  const localizedStyles = localizeTags(styleTags).slice(0, 2).join("、") || "画风";
  const localizedSubjects = localizeTags(subjectTags).slice(0, 4).join("、") || "主体元素";
  return `根据画面里的${localizedSubjects}以及${localizedStyles}特征，补充了背景、光线、构图和细节质量信息，让提示词更适合直接用于绘图模型。`;
}

function normalizeStyleProfile(input, promptTexts) {
  const profile = emptyStyleProfile();
  const combined = promptTexts.join(" ").toLowerCase();

  for (const [category, allowedLabels] of Object.entries(STYLE_TAXONOMY)) {
    const rawItems = Array.isArray(input?.[category]) ? input[category] : [];
    profile[category] = dedupeScoredEntries(
      rawItems
        .map((item) => ({
          label: normalizeTaxonomyLabel(item?.label, allowedLabels),
          score: normalizeConfidence(item?.score)
        }))
        .filter((item) => item.label)
    );
  }

  if (/\banime\b|\bmanga\b|\bcartoon\b/.test(combined)) {
    pushScored(profile.renderStyle, "anime", 0.82);
  }
  if (/\b3d\b|\brender\b|\brendering\b|\bcgi\b/.test(combined)) {
    pushScored(profile.medium, "3d", 0.9);
    pushScored(profile.renderStyle, "cgi", 0.78);
  }
  if (/\bstylized\b|\bcute\b|\bchibi\b/.test(combined)) {
    pushScored(profile.renderStyle, "stylized", 0.78);
    pushScored(profile.aesthetic, "cute", 0.72);
  }
  if (/\bdoll\b|\bfigurine\b|\btoy-like\b|\btoy like\b/.test(combined)) {
    pushScored(profile.renderStyle, "doll_like", 0.8);
  }

  resolveStyleProfileConflicts(profile);
  return profile;
}

function adaptStyleProfileForScene(styleProfile, sceneType, promptTexts) {
  const profile = cloneStyleProfile(styleProfile);
  const joined = promptTexts.join(" ").toLowerCase();
  const allowsCute = /\bcute\b|\bkawaii\b|\btoy\b|\bminiature\b|\bicon\b/.test(joined);
  const allowsDoll = /\bdoll\b|\bfigurine\b|\btoy-like\b/.test(joined);

  if (sceneType === "vehicle" || sceneType === "architecture" || sceneType === "interior" || sceneType === "landscape") {
    if (!allowsCute) {
      profile.aesthetic = profile.aesthetic.filter((item) => item.label !== "cute");
    }
    if (!allowsDoll) {
      profile.renderStyle = profile.renderStyle.filter((item) => item.label !== "doll_like");
    }
  }

  if (sceneType === "vehicle") {
    pushScored(profile.composition, "centered", 0.58);
  }

  return profile;
}

function deriveStyleTags(styleProfile, rawStyleTags, promptTexts, sceneType) {
  const tags = [...rawStyleTags];
  const combined = [rawStyleTags.join(" "), ...promptTexts].join(" ").toLowerCase();

  for (const category of Object.keys(styleProfile)) {
    const top = styleProfile[category][0];
    if (top && top.score >= 0.45) {
      tags.push(top.label.replaceAll("_", " "));
    }
  }

  if (/\banime\b/.test(combined)) {
    tags.push("anime");
  }
  if (/\b3d\b|\brender\b|\bcgi\b/.test(combined)) {
    tags.push("3D rendering");
  }
  if (/\bstylized\b/.test(combined)) {
    tags.push("stylized 3D");
  }
  if (/\bdoll\b|\bfigurine\b/.test(combined) && sceneType === "character") {
    tags.push("doll-like");
  }

  return dedupeStrings(
    tags
      .map((tag) => String(tag || "").trim())
      .filter(Boolean)
      .filter((tag) => {
        const lower = tag.toLowerCase();
        if (lower === "realism" || lower === "realistic") {
        return !(
            hasStrongStyle(styleProfile.renderStyle, "anime") ||
            hasStrongStyle(styleProfile.medium, "3d") ||
            hasStrongStyle(styleProfile.renderStyle, "stylized") ||
            hasStrongStyle(styleProfile.renderStyle, "doll_like")
        );
      }
      if ((lower === "cute" || lower === "doll-like" || lower === "doll like") && sceneType !== "character") {
        return false;
      }
      return true;
    })
  );
}

function deriveSubjectTags(rawSubjectTags, promptTexts, sceneType) {
  const tags = [...rawSubjectTags];
  const joined = promptTexts.join(" ").toLowerCase();

  const pushIfSeen = (phrase) => {
    if (joined.includes(phrase)) {
      tags.push(phrase);
    }
  };

  if (sceneType === "character") {
    [
      "girl",
      "woman",
      "female cyborg",
      "cyborg",
      "white hair",
      "blue eyes",
      "pink cheeks",
      "hoodie",
      "zipper",
      "drawstrings",
      "mechanical arm",
      "robotic armor",
      "futuristic mask",
      "dark background"
    ].forEach(pushIfSeen);
    CHARACTER_STYLE_HINTS.forEach(pushIfSeen);
  } else if (sceneType === "vehicle") {
    ["container ship", "port", "crane", "cranes", "building", "buildings"].forEach(pushIfSeen);
  } else if (sceneType === "architecture") {
    ["building", "facade", "bridge", "tower"].forEach(pushIfSeen);
  } else if (sceneType === "interior") {
    ["sofa", "bed", "table", "chair", "window", "lamp"].forEach(pushIfSeen);
  } else if (sceneType === "landscape") {
    ["mountain", "river", "forest", "sky", "beach"].forEach(pushIfSeen);
  } else if (sceneType === "object") {
    [
      "cloud",
      "cloud icon",
      "cloud computing",
      "dashboard",
      "analytics dashboard",
      "data visualization",
      "chart",
      "bar chart",
      "pie chart",
      "graph",
      "tablet",
      "screen",
      "interface",
      "platform",
      "product showcase"
    ].forEach(pushIfSeen);
  }

  return dedupeStrings(tags);
}

function resolveStyleProfileConflicts(profile) {
  if (
    hasStrongStyle(profile.renderStyle, "anime") ||
    hasStrongStyle(profile.medium, "3d") ||
    hasStrongStyle(profile.renderStyle, "stylized") ||
    hasStrongStyle(profile.renderStyle, "doll_like")
  ) {
    profile.renderStyle = profile.renderStyle.filter((item) => item.label !== "realistic");
  }

  if (hasStrongStyle(profile.renderStyle, "doll_like")) {
    pushScored(profile.renderStyle, "stylized", 0.76);
    pushScored(profile.aesthetic, "cute", 0.68);
  }

  if (hasStrongStyle(profile.medium, "3d")) {
    pushScored(profile.renderStyle, "cgi", 0.72);
  }

  if (hasStrongStyle(profile.renderStyle, "stylized") || hasStrongStyle(profile.renderStyle, "anime")) {
    profile.renderStyle = profile.renderStyle.filter((item) => item.label !== "realistic");
  }
}

function buildPromptStylePhrases(styleProfile, styleTags, lowerPrompt, sceneType) {
  const phrases = [];
  const medium = styleProfile.medium[0]?.label;
  const render = styleProfile.renderStyle[0]?.label;
  const aesthetic = styleProfile.aesthetic[0]?.label;
  const lighting = styleProfile.lighting[0]?.label;
  const composition = styleProfile.composition[0]?.label;
  const material = styleProfile.material[0]?.label;

  const promptHas = (text) => lowerPrompt.includes(text.toLowerCase());

  if (medium === "3d" && render === "anime") {
    phrases.push("anime-inspired 3D render");
  } else if (medium === "3d" && render === "stylized") {
    phrases.push("stylized 3D render");
  } else if (medium === "3d" && render === "doll_like") {
    phrases.push("doll-like 3D render");
  } else if (medium === "3d" && render === "cgi") {
    phrases.push("clean CGI render");
  } else {
    phrases.push(...compactStyleTags(styleTags, sceneType).filter((tag) => !promptHas(tag)).slice(0, 3));
  }

  if (render === "doll_like" && sceneType === "character" && !promptHas("doll-like")) {
    phrases.push("doll-like character");
  }
  if (aesthetic === "cute" && sceneType === "character" && !promptHas("cute")) {
    phrases.push("cute character styling");
  }
  if (lighting === "soft" && !/\bsoft lighting\b/.test(lowerPrompt)) {
    phrases.push("soft lighting");
  }
  if (lighting === "cool_tone" && !promptHas("cool-toned")) {
    phrases.push("cool-toned palette");
  }
  if (composition === "bust_shot" && sceneType === "character" && !promptHas("bust portrait")) {
    phrases.push("bust portrait");
  }
  if (composition === "front_view" && !promptHas("front view")) {
    phrases.push("front view");
  }
  if (material === "smooth" && !promptHas("smooth")) {
    phrases.push("smooth clean surfaces");
  }
  if (material === "matte" && !promptHas("matte")) {
    phrases.push("matte fabric texture");
  }

  if (sceneType === "vehicle") {
    if (!promptHas("industrial")) {
      phrases.push("industrial scene");
    }
    if (!promptHas("geometric")) {
      phrases.push("clean geometric forms");
    }
  }

  if (sceneType === "architecture" && !promptHas("architectural")) {
    phrases.push("architectural visualization");
  }

  if (sceneType === "poster" && !promptHas("graphic")) {
    phrases.push("graphic design composition");
  }

  if (sceneType === "object") {
    const objectJoined = `${lowerPrompt} ${styleTags.join(" ").toLowerCase()}`;
    const isTechDisplay =
      /\b(cloud|dashboard|analytics|data visualization|bar chart|pie chart|chart|graph|tablet|screen|interface|product showcase)\b/.test(
        objectJoined
      );

    if (isTechDisplay) {
      if (!promptHas("cloud computing")) {
        phrases.push("cloud computing concept");
      }
      if (!promptHas("data visualization")) {
        phrases.push("data visualization elements");
      }
      if (!promptHas("dashboard interface")) {
        phrases.push("dashboard interface display");
      }
      if (!promptHas("product showcase")) {
        phrases.push("minimal product showcase");
      }
      if (!promptHas("tech platform")) {
        phrases.push("clean layered tech platform");
      }
      if (!promptHas("blue and white")) {
        phrases.push("blue and white palette");
      }
      if (!promptHas("ambient lighting")) {
        phrases.push("soft ambient lighting");
      }
    }
  }

  if (sceneType === "character") {
    const lowerTags = styleTags.map((tag) => String(tag || "").toLowerCase());
    const lowerJoined = `${lowerPrompt} ${lowerTags.join(" ")}`;

    if (/\bcyberpunk\b/.test(lowerJoined) && !promptHas("cyberpunk")) {
      phrases.push("cyberpunk aesthetic");
    }
    if ((/\bcyborg\b|\bandroid\b|\brobotic\b|\bcybernetic\b/.test(lowerJoined)) && !promptHas("cybernetic")) {
      phrases.push("cybernetic body details");
    }
    if ((/\bmecha\b|\bmechanical\b|\brobotic armor\b/.test(lowerJoined)) && !promptHas("mecha")) {
      phrases.push("mecha-inspired armor design");
    }
    if ((/\bsci-fi\b|\bfuturistic\b|\bhigh-tech\b/.test(lowerJoined)) && !promptHas("sci-fi")) {
      phrases.push("sci-fi character design");
    }
  }

  return dedupeStrings(phrases);
}

function sanitizePromptSeed(prompt, sceneType) {
  let text = String(prompt || "")
    .replace(/\.\s+/g, ", ")
    .replace(/;\s+/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,\s]+$/g, "");

  text = text
    .replace(/\bthe image is rendered in\b/gi, "rendered in")
    .replace(/\bthe image is\b/gi, "")
    .replace(/\bthe artwork showcases\b/gi, "")
    .replace(/\bthe artwork features\b/gi, "")
    .replace(/\bthe composition features\b/gi, "")
    .replace(/\bthe composition shows\b/gi, "")
    .replace(/\bthe scene features\b/gi, "")
    .replace(/\bthe scene shows\b/gi, "")
    .replace(/\bthis artwork shows\b/gi, "")
    .replace(/\bthis image shows\b/gi, "")
    .replace(/\bthis image depicts\b/gi, "")
    .replace(/\bthis artwork depicts\b/gi, "")
    .replace(/\bdepicts\b/gi, "")
    .replace(/\bshowcasing\b/gi, "with")
    .replace(/\bfeaturing\b/gi, "with")
    .replace(/\bThe hair is styled in\b/gi, "hair styled in")
    .replace(/\bthe eyes have\b/gi, "eyes with")
    .replace(/\bthe hoodie features\b/gi, "hoodie with")
    .replace(/\bcapturing the subject from\b/gi, "")
    .replace(/\bthat highlights\b/gi, "highlighting")
    .replace(/\bthat emphasize(s)?\b/gi, "emphasizing")
    .replace(/\bwhich highlights\b/gi, "highlighting")
    .replace(/\bwhich emphasizes\b/gi, "emphasizing")
    .replace(/\bwith a\b/gi, "with")
    .replace(/\bwith an\b/gi, "with")
    .replace(/\bwith the\b/gi, "with")
    .replace(/\bthe artwork\b/gi, "")
    .replace(/\bthe composition\b/gi, "")
    .replace(/\bthe scene\b/gi, "")
    .replace(/\bthe subject\b/gi, "")
    .replace(/\band the subject'?s form\b/gi, "")
    .replace(/\bof the armor\b/gi, "armor")
    .replace(/\bof the subject\b/gi, "")
    .replace(/\bthe image\b/gi, "")
    .replace(/\bit highlights\b/gi, "highlighting")
    .replace(/\bit emphasizes\b/gi, "emphasizing")
    .replace(/\bfeatures a\b/gi, "")
    .replace(/\bfeatures an\b/gi, "")
    .replace(/\bfeatures\b/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/,{2,}/g, ",")
    .trim();

  if (sceneType !== "character") {
    text = text
      .replace(/\bfull body view\b/gi, "")
      .replace(/\bclose-up portrait view\b/gi, "")
      .replace(/\bcentered character portrait\b/gi, "")
      .replace(/\bbust portrait\b/gi, "")
      .replace(/\bcharacter portrait\b/gi, "")
      .replace(/\bportrait view\b/gi, "")
      .replace(/\bcute character styling\b/gi, "")
      .replace(/\bfull body view\b/gi, "")
      .replace(/\s+,/g, ",")
      .replace(/,{2,}/g, ",")
      .replace(/^,\s*/g, "")
      .replace(/[,\s]+$/g, "")
      .trim();
  }

  text = text
    .replace(/\bthere is\b/gi, "")
    .replace(/\bit is\b/gi, "")
    .replace(/\bthis is\b/gi, "")
    .replace(/\bthe\b/gi, " ")
    .replace(/\s+,/g, ",")
    .replace(/,{2,}/g, ",")
    .replace(/,\s*,/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/^,\s*/g, "")
    .replace(/[,\s]+$/g, "")
    .trim();

  return text;
}

function buildProtectedTerms(subjectTags, promptTexts) {
  const terms = new Set();

  for (const tag of subjectTags || []) {
    const normalized = String(tag || "").trim().toLowerCase();
    if (normalized) {
      terms.add(normalized);
    }
  }

  const joinedText = (promptTexts || []).join(" ").toLowerCase();
  const phrasePatterns = [
    "white hair",
    "blue eyes",
    "pink blush",
    "pink cheeks",
    "white hoodie",
    "hoodie",
    "light blue background",
    "girl",
    "female",
    "character",
    "zipper",
    "drawstrings",
    "bust shot",
    "portrait"
  ];

  for (const phrase of phrasePatterns) {
    if (joinedText.includes(phrase)) {
      terms.add(phrase);
    }
  }

  return Array.from(terms);
}

function emptyStyleProfile() {
  return {
    medium: [],
    renderStyle: [],
    aesthetic: [],
    lighting: [],
    composition: [],
    material: []
  };
}

function cloneStyleProfile(styleProfile) {
  const cloned = {};
  for (const [category, items] of Object.entries(styleProfile || emptyStyleProfile())) {
    cloned[category] = (items || []).map((item) => ({ ...item }));
  }
  return cloned;
}

function normalizeTaxonomyLabel(label, allowedLabels) {
  const normalized = String(label || "").trim().toLowerCase().replaceAll(" ", "_");
  return allowedLabels.includes(normalized) ? normalized : "";
}

function dedupeScoredEntries(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry.label) {
      continue;
    }
    const existing = map.get(entry.label);
    if (!existing || existing.score < entry.score) {
      map.set(entry.label, entry);
    }
  }

  return Array.from(map.values()).sort((a, b) => b.score - a.score).slice(0, 3);
}

function pushScored(target, label, score) {
  const existing = target.find((item) => item.label === label);
  if (existing) {
    existing.score = Math.max(existing.score, score);
  } else {
    target.push({ label, score });
  }
  target.sort((a, b) => b.score - a.score);
  if (target.length > 3) {
    target.length = 3;
  }
}

function hasStrongStyle(entries, label) {
  return entries.some((item) => item.label === label && item.score >= 0.5);
}

function localizeStyleProfile(styleProfile) {
  const localized = {};
  for (const [category, items] of Object.entries(styleProfile || {})) {
    localized[category] = (items || []).map((item) => ({
      label: TAG_TRANSLATIONS[item.label] || item.label,
      score: item.score
    }));
  }
  return localized;
}

function normalizeSceneType(sceneType, subjectTags, promptTexts, styleProfile) {
  const normalized = String(sceneType || "").trim().toLowerCase();
  if (SCENE_TYPES.includes(normalized)) {
    return normalized;
  }

  const joined = `${subjectTags.join(" ")} ${promptTexts.join(" ")}`.toLowerCase();
  if (/\b(ship|boat|truck|car|bus|train|plane|aircraft|vehicle|port|dock|harbor)\b/.test(joined)) {
    return "vehicle";
  }
  if (/\b(room|interior|bedroom|living room|kitchen|office)\b/.test(joined)) {
    return "interior";
  }
  if (/\bbuilding|house|tower|architecture|facade|bridge\b/.test(joined)) {
    return "architecture";
  }
  if (/\bposter|cover|banner|flyer|advertisement|typography\b/.test(joined)) {
    return "poster";
  }
  if (/\bmountain|forest|river|skyline|beach|landscape|nature\b/.test(joined)) {
    return "landscape";
  }
  if (/\bgirl|boy|woman|man|person|portrait|character|face\b/.test(joined)) {
    return "character";
  }
  if (hasStrongStyle(styleProfile.composition, "portrait")) {
    return "character";
  }
  return "object";
}

function defaultCompositionPhrase(sceneType, styleProfile) {
  if (sceneType === "character") {
    if (hasStrongStyle(styleProfile.composition, "close_up")) {
      return "close-up portrait";
    }
    if (hasStrongStyle(styleProfile.composition, "bust_shot")) {
      return "upper-body bust portrait";
    }
    return "upper-body three-quarter portrait";
  }
  if (sceneType === "vehicle") {
    return "clean industrial composition";
  }
  if (sceneType === "architecture") {
    return "clean architectural composition";
  }
  if (sceneType === "interior") {
    return "balanced interior composition";
  }
  if (sceneType === "landscape") {
    return "wide scenic composition";
  }
  if (sceneType === "poster") {
    return "clean poster composition";
  }
  return "centered object composition";
}

function defaultBackgroundPhrase(sceneType) {
  if (sceneType === "vehicle") {
    return "minimal industrial background";
  }
  if (sceneType === "architecture") {
    return "clean architectural setting";
  }
  if (sceneType === "interior") {
    return "clean interior setting";
  }
  if (sceneType === "landscape") {
    return "atmospheric environment";
  }
  if (sceneType === "poster") {
    return "minimal graphic background";
  }
  if (sceneType === "object") {
    return "minimal product showcase environment";
  }
  return "clean studio background";
}

function defaultNegativeTerms(sceneType) {
  if (sceneType === "character") {
    return ["blurry", "low quality", "bad anatomy", "extra fingers", "distorted face"];
  }
  if (sceneType === "vehicle") {
    return ["blurry", "low quality", "warped geometry", "broken perspective", "messy composition"];
  }
  if (sceneType === "architecture" || sceneType === "interior") {
    return ["blurry", "low quality", "warped perspective", "crooked lines", "messy composition"];
  }
  if (sceneType === "landscape") {
    return ["blurry", "low quality", "muddy colors", "flat lighting", "messy composition"];
  }
  if (sceneType === "poster") {
    return ["blurry", "low quality", "messy layout", "cluttered composition", "poor readability"];
  }
  return ["blurry", "low quality", "warped geometry", "messy composition", "low detail"];
}

function isHighValueNegativeTerm(term, sceneType) {
  const common = [
    "blurry",
    "low quality",
    "low detail",
    "messy composition",
    "warped geometry",
    "broken perspective",
    "distorted face",
    "bad anatomy",
    "extra fingers",
    "crooked lines",
    "muddy colors",
    "poor readability",
    "cluttered composition",
    "noisy texture"
  ];

  if (common.some((item) => term.includes(item))) {
    return true;
  }

  if (sceneType === "character") {
    return /\b(anatomy|fingers|face|eyes|hands)\b/.test(term);
  }

  if (sceneType === "vehicle" || sceneType === "architecture" || sceneType === "interior") {
    return /\b(geometry|perspective|lines|structure)\b/.test(term);
  }

  if (sceneType === "poster") {
    return /\b(layout|readability|typography)\b/.test(term);
  }

  return false;
}

function compactStyleTags(styleTags, sceneType) {
  const tags = dedupeStrings(styleTags);
  if (sceneType === "vehicle" || sceneType === "architecture" || sceneType === "interior") {
    return tags.filter((tag) => {
      const lower = tag.toLowerCase();
      return lower !== "realistic" && lower !== "realism" && lower !== "cute";
    });
  }
  return tags;
}

function buildPromptVariants(prompt) {
  const base = prompt.replace(/\s+/g, " ").trim().replace(/[,\s]+$/g, "");
  return {
    general: base,
    midjourney: `${base}, cinematic composition, polished stylization, refined lighting, ultra detailed --ar 3:4 --stylize 150 --v 7`,
    sdxl: `${base}, masterpiece, best quality, highly detailed, clean composition`,
    flux: `${base}, precise forms, rich material detail, soft global illumination, crisp render quality`
  };
}

function buildPromptVariantMatrix(promptModes) {
  return {
    detailed: buildPromptVariants(promptModes.detailed || ""),
    pro: buildPromptVariants(promptModes.pro || promptModes.detailed || "")
  };
}

async function buildLocalizedPromptBundle(promptModes, promptVariants, negativePrompt) {
  const englishBundle = {
    localizedPromptModes: { ...promptModes },
    localizedPromptVariants: clonePromptVariantMatrix(promptVariants),
    localizedNegativePrompt: negativePrompt || ""
  };

  const promptTexts = [
    promptModes?.detailed,
    promptModes?.pro,
    negativePrompt
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  if (!promptTexts.length || promptTexts.every(containsChinese)) {
    return englishBundle;
  }

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    return englishBundle;
  }

  try {
    const translated = await translatePromptBundleWithGlm(apiKey, promptModes, promptVariants, negativePrompt);
    let cleanedBundle = cleanTranslatedPromptBundle(translated, promptModes, promptVariants, negativePrompt);
    let validation = validateTranslatedBundleFidelity(cleanedBundle, promptModes, promptVariants, negativePrompt);

    if (!validation.ok) {
      const repaired = await translatePromptBundleWithGlm(apiKey, promptModes, promptVariants, negativePrompt, validation);
      cleanedBundle = cleanTranslatedPromptBundle(repaired, promptModes, promptVariants, negativePrompt);
      validation = validateTranslatedBundleFidelity(cleanedBundle, promptModes, promptVariants, negativePrompt);
    }

    if (validation.ok) {
      return cleanedBundle;
    }

    console.warn("Prompt localization validation failed:", validation.issues);
    return bundleLooksTranslated(cleanedBundle) ? cleanedBundle : englishBundle;
  } catch (error) {
    console.error("Prompt localization failed:", error);
    return englishBundle;
  }
}

async function buildLocalizedSinglePrompt(promptText, negativePrompt) {
  const sourcePrompt = String(promptText || "").trim();
  const sourceNegative = String(negativePrompt || "").trim();

  if (!sourcePrompt) {
    const error = new Error("promptText is required");
    error.statusCode = 400;
    throw error;
  }

  if (containsChinese(sourcePrompt) && (!sourceNegative || containsChinese(sourceNegative))) {
    return {
      localizedPrompt: sourcePrompt,
      localizedNegativePrompt: sourceNegative
    };
  }

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    const error = new Error("ZHIPU_API_KEY is not configured");
    error.statusCode = 500;
    throw error;
  }

  const entries = [{ id: "t0", text: sourcePrompt }];
  if (sourceNegative) {
    entries.push({ id: "t1", text: sourceNegative });
  }

  const requiredTermHints = collectRequiredTranslationTerms(`${sourcePrompt} ${sourceNegative}`);
  let translations = await translateEntryChunkWithGlm(apiKey, entries, requiredTermHints);
  let result = cleanTranslatedSinglePrompt(translations, sourcePrompt, sourceNegative);
  let validation = validateTranslatedSinglePromptFidelity(result, sourcePrompt, sourceNegative);

  if (!validation.ok) {
    translations = await translateEntryChunkWithGlm(apiKey, entries, requiredTermHints, {
      previousTranslationRejected: true,
      reason: "The previous single-prompt translation lost source information or left invalid output.",
      issues: validation.issues,
      requiredAction:
        "Translate the original English prompt sentence by sentence. Preserve every concrete subject/object explicitly. Do not summarize or convert to tags."
    });
    result = cleanTranslatedSinglePrompt(translations, sourcePrompt, sourceNegative);
    validation = validateTranslatedSinglePromptFidelity(result, sourcePrompt, sourceNegative);
  }

  if (!validation.ok) {
    console.warn("Single prompt localization validation failed:", validation.issues);
    const error = new Error("中文翻译结果不可用，请稍后重试");
    error.statusCode = 502;
    throw error;
  }

  return result;
}

function cleanTranslatedSinglePrompt(translations, sourcePrompt, sourceNegative) {
  return {
    localizedPrompt: cleanTranslatedPromptText(translations.t0 || translations.prompt || sourcePrompt || ""),
    localizedNegativePrompt: cleanTranslatedPromptText(translations.t1 || translations.negativePrompt || sourceNegative || "")
  };
}

function validateTranslatedSinglePromptFidelity(result, sourcePrompt, sourceNegative) {
  const issues = [];
  validateTranslatedField(issues, "prompt", result.localizedPrompt, sourcePrompt);
  if (sourceNegative) {
    validateTranslatedField(issues, "negativePrompt", result.localizedNegativePrompt, sourceNegative);
  }

  return {
    ok: issues.length === 0,
    issues: dedupeStrings(issues).slice(0, 12)
  };
}

async function translatePromptBundleWithGlm(apiKey, promptModes, promptVariants, negativePrompt, repairContext) {
  const translationRequest = buildTranslationRequest(promptModes, promptVariants, negativePrompt);
  const requiredTermHints = collectRequiredTranslationTermsFromBundle(promptModes, promptVariants, negativePrompt);
  const repairInstructions = repairContext
    ? {
        previousTranslationRejected: true,
        reason: "The previous translation lost source information or left invalid output.",
        issues: repairContext.issues,
        requiredAction:
          "Translate again from the original English only. Preserve every listed subject/object explicitly. Do not shorten into tags."
      }
    : undefined;

  const translations = {};
  for (const entries of chunkArray(translationRequest.entries, TRANSLATION_CHUNK_SIZE)) {
    Object.assign(
      translations,
      await translateEntryChunkWithGlm(apiKey, entries, requiredTermHints, repairInstructions)
    );
  }

  return expandTranslatedPromptBundle({ translations }, translationRequest);
}

async function translateEntryChunkWithGlm(apiKey, entries, requiredTermHints, repairInstructions) {
  try {
    return await requestTranslationEntryChunk(apiKey, entries, requiredTermHints, repairInstructions);
  } catch (error) {
    if (entries.length <= 1) {
      throw error;
    }

    const middleIndex = Math.ceil(entries.length / 2);
    const left = await translateEntryChunkWithGlm(
      apiKey,
      entries.slice(0, middleIndex),
      requiredTermHints,
      repairInstructions
    );
    const right = await translateEntryChunkWithGlm(
      apiKey,
      entries.slice(middleIndex),
      requiredTermHints,
      repairInstructions
    );
    return { ...left, ...right };
  }
}

async function requestTranslationEntryChunk(apiKey, entries, requiredTermHints, repairInstructions) {
  const response = await fetch(ZHIPU_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: TRANSLATION_MODEL_NAME,
      temperature: 0.15,
      max_tokens: 3000,
      messages: [
        {
          role: "system",
          content:
            "You are a strict English-to-Simplified-Chinese translator for AI image-generation prompts. " +
            "Your only task is translating the provided final English prompts sentence by sentence. " +
            "Do not generate a new prompt. Do not summarize. Do not rewrite style. Do not compress into tags. " +
            "Do not add any visual information that is not in the English source. " +
            "Every subject, object, count-like list item, color, material, lighting, composition, environment, and spatial relation in the English source must remain present in Chinese. " +
            "If the source lists objects such as airplane, truck, ship, containers, boxes, buildings, people, products, or devices, translate every listed object explicitly. " +
            "Do not replace concrete objects with abstract words like scene, concept, product, logistics, technology, or environment. " +
            "Return strict JSON only in this shape: {\"translations\":{\"t0\":\"Chinese translation\",\"t1\":\"Chinese translation\"}}. Keep every entry id exactly. " +
            "Do not output markdown, code fences, explanations, or nested JSON strings. " +
            "Do not leave ordinary English words in the Chinese result. Translate abbreviations such as CGI, AI, UI, and UX into natural Chinese. " +
            "Preserve model names and generation flags exactly, including Midjourney, SDXL, Flux, 3D, --ar, --stylize, --style, --v, and their values. Do not translate, delete, or reorder generation flags."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              entries,
              requiredTermHints,
              repairInstructions
            },
            null,
            2
          )
        }
      ]
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || "GLM translation request failed");
  }

  const contentText = normalizeModelContent(payload.choices?.[0]?.message?.content);
  const parsed = parseModelJson(contentText);
  if (!parsed) {
    throw new Error("GLM translation response did not include valid JSON");
  }

  const translations = normalizeTranslationMap(parsed);
  const missingIds = entries.filter((entry) => !translations[entry.id]).map((entry) => entry.id);
  if (missingIds.length) {
    throw new Error(`GLM translation response missed entries: ${missingIds.join(", ")}`);
  }

  return translations;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildTranslationRequest(promptModes, promptVariants, negativePrompt) {
  const entries = [];
  const textToId = new Map();
  const pathToId = {};

  const add = (pathName, text) => {
    const sourceText = String(text || "").trim();
    if (!sourceText) {
      return;
    }

    let id = textToId.get(sourceText);
    if (!id) {
      id = `t${entries.length}`;
      textToId.set(sourceText, id);
      entries.push({ id, text: sourceText });
    }

    pathToId[pathName] = id;
  };

  add("promptModes.detailed", promptModes?.detailed);
  add("promptModes.pro", promptModes?.pro || promptModes?.detailed);
  add("promptVariants.detailed.general", promptVariants?.detailed?.general);
  add("promptVariants.detailed.midjourney", promptVariants?.detailed?.midjourney);
  add("promptVariants.detailed.sdxl", promptVariants?.detailed?.sdxl);
  add("promptVariants.detailed.flux", promptVariants?.detailed?.flux);
  add("promptVariants.pro.general", promptVariants?.pro?.general);
  add("promptVariants.pro.midjourney", promptVariants?.pro?.midjourney);
  add("promptVariants.pro.sdxl", promptVariants?.pro?.sdxl);
  add("promptVariants.pro.flux", promptVariants?.pro?.flux);
  add("negativePrompt", negativePrompt);

  return { entries, pathToId };
}

function expandTranslatedPromptBundle(parsed, translationRequest) {
  const translations = normalizeTranslationMap(parsed);
  const textForPath = (pathName) => translations[translationRequest.pathToId[pathName]] || translations[pathName] || "";

  return {
    promptModes: {
      detailed: textForPath("promptModes.detailed"),
      pro: textForPath("promptModes.pro")
    },
    promptVariants: {
      detailed: {
        general: textForPath("promptVariants.detailed.general"),
        midjourney: textForPath("promptVariants.detailed.midjourney"),
        sdxl: textForPath("promptVariants.detailed.sdxl"),
        flux: textForPath("promptVariants.detailed.flux")
      },
      pro: {
        general: textForPath("promptVariants.pro.general"),
        midjourney: textForPath("promptVariants.pro.midjourney"),
        sdxl: textForPath("promptVariants.pro.sdxl"),
        flux: textForPath("promptVariants.pro.flux")
      }
    },
    negativePrompt: textForPath("negativePrompt")
  };
}

function normalizeTranslationMap(parsed) {
  if (parsed.translations && !Array.isArray(parsed.translations) && typeof parsed.translations === "object") {
    return parsed.translations;
  }

  if (Array.isArray(parsed.translations)) {
    return Object.fromEntries(
      parsed.translations
        .filter((item) => item && item.id && item.text)
        .map((item) => [String(item.id), String(item.text)])
    );
  }

  return parsed && typeof parsed === "object" ? parsed : {};
}

function clonePromptVariantMatrix(promptVariants) {
  return {
    detailed: { ...promptVariants.detailed },
    pro: { ...promptVariants.pro }
  };
}

function bundleHasChinese(bundle) {
  return Boolean(
    containsChinese(bundle.localizedPromptModes?.detailed) ||
      containsChinese(bundle.localizedPromptModes?.pro) ||
      containsChinese(bundle.localizedNegativePrompt)
  );
}

function bundleHasJsonLeak(bundle) {
  const texts = [
    bundle.localizedPromptModes?.detailed,
    bundle.localizedPromptModes?.pro,
    bundle.localizedPromptVariants?.detailed?.general,
    bundle.localizedPromptVariants?.detailed?.midjourney,
    bundle.localizedPromptVariants?.detailed?.sdxl,
    bundle.localizedPromptVariants?.detailed?.flux,
    bundle.localizedPromptVariants?.pro?.general,
    bundle.localizedPromptVariants?.pro?.midjourney,
    bundle.localizedPromptVariants?.pro?.sdxl,
    bundle.localizedPromptVariants?.pro?.flux,
    bundle.localizedNegativePrompt
  ];

  return texts.some((item) => /```|\bjson\b|"\s*(promptModes|promptVariants|negativePrompt|prompt|detailedPrompt)\s*"/i.test(String(item || "")));
}

function bundleLooksTranslated(bundle) {
  return bundleHasChinese(bundle) && !bundleHasJsonLeak(bundle) && !bundleEnglishResidualWords(bundle).length;
}

function bundleEnglishResidualWords(bundle) {
  const texts = [
    bundle.localizedPromptModes?.detailed,
    bundle.localizedPromptModes?.pro,
    bundle.localizedPromptVariants?.detailed?.general,
    bundle.localizedPromptVariants?.detailed?.midjourney,
    bundle.localizedPromptVariants?.detailed?.sdxl,
    bundle.localizedPromptVariants?.detailed?.flux,
    bundle.localizedPromptVariants?.pro?.general,
    bundle.localizedPromptVariants?.pro?.midjourney,
    bundle.localizedPromptVariants?.pro?.sdxl,
    bundle.localizedPromptVariants?.pro?.flux,
    bundle.localizedNegativePrompt
  ];

  return dedupeStrings(texts.flatMap((item) => getOrdinaryEnglishWords(item)));
}

function cleanTranslatedPromptBundle(translated, promptModes, promptVariants, negativePrompt) {
  const translatedModes = translated.promptModes || {};
  const localizedPromptModes = {
    detailed: cleanTranslatedPromptText(
      translatedModes.detailed ||
        translatedModes.pro ||
        promptModes.detailed ||
        ""
    ),
    pro: cleanTranslatedPromptText(
      translatedModes.pro ||
        translatedModes.detailed ||
        promptModes.pro ||
        promptModes.detailed ||
        ""
    )
  };

  return {
    localizedPromptModes,
    localizedPromptVariants: {
      detailed: cleanTranslatedVariantRow(translated.promptVariants?.detailed, localizedPromptModes.detailed),
      pro: cleanTranslatedVariantRow(translated.promptVariants?.pro, localizedPromptModes.pro)
    },
    localizedNegativePrompt: cleanTranslatedPromptText(translated.negativePrompt || negativePrompt || "")
  };
}

function cleanTranslatedVariantRow(translatedRow, fallbackText) {
  const fallback = cleanTranslatedPromptText(fallbackText || "");
  return {
    general: cleanTranslatedPromptText(translatedRow?.general || fallback),
    midjourney: cleanTranslatedPromptText(translatedRow?.midjourney || fallback),
    sdxl: cleanTranslatedPromptText(translatedRow?.sdxl || fallback),
    flux: cleanTranslatedPromptText(translatedRow?.flux || fallback)
  };
}

function cleanTranslatedPromptText(text) {
  const unwrapped = unwrapPromptJsonLeak(String(text || "").trim());
  return unwrapped
    .replace(/```json|```/gi, "")
    .replace(/\bCGI\b/gi, "计算机生成图像")
    .replace(/(^|[^A-Za-z])CG(?=$|[^A-Za-z])/g, "$1计算机图形")
    .replace(/\bAI\b/gi, "人工智能")
    .replace(/\bUI\b/gi, "用户界面")
    .replace(/\bUX\b/gi, "用户体验")
    .replace(/\s+/g, " ")
    .replace(/\s*([，。；、])\s*/g, "$1")
    .trim();
}

function validateTranslatedBundleFidelity(bundle, promptModes, promptVariants, negativePrompt) {
  const issues = [];
  validateTranslatedField(issues, "promptModes.detailed", bundle.localizedPromptModes?.detailed, promptModes?.detailed);
  validateTranslatedField(issues, "promptModes.pro", bundle.localizedPromptModes?.pro, promptModes?.pro || promptModes?.detailed);
  validateTranslatedVariantRow(issues, "promptVariants.detailed", bundle.localizedPromptVariants?.detailed, promptVariants?.detailed);
  validateTranslatedVariantRow(issues, "promptVariants.pro", bundle.localizedPromptVariants?.pro, promptVariants?.pro);
  validateTranslatedField(issues, "negativePrompt", bundle.localizedNegativePrompt, negativePrompt);

  if (!bundleHasChinese(bundle)) {
    issues.push("No Simplified Chinese text was returned.");
  }

  if (bundleHasJsonLeak(bundle)) {
    issues.push("Output contains JSON/code-fence leakage.");
  }

  return {
    ok: issues.length === 0,
    issues: dedupeStrings(issues).slice(0, 24)
  };
}

function validateTranslatedVariantRow(issues, pathPrefix, localizedRow, sourceRow) {
  validateTranslatedField(issues, `${pathPrefix}.general`, localizedRow?.general, sourceRow?.general);
  validateTranslatedField(issues, `${pathPrefix}.midjourney`, localizedRow?.midjourney, sourceRow?.midjourney);
  validateTranslatedField(issues, `${pathPrefix}.sdxl`, localizedRow?.sdxl, sourceRow?.sdxl);
  validateTranslatedField(issues, `${pathPrefix}.flux`, localizedRow?.flux, sourceRow?.flux);
}

function validateTranslatedField(issues, pathName, localizedText, sourceText) {
  const source = String(sourceText || "").trim();
  if (!source) {
    return;
  }

  const localized = String(localizedText || "").trim();
  if (!localized) {
    issues.push(`${pathName}: empty translation.`);
    return;
  }

  if (/```|\bjson\b|"\s*(promptModes|promptVariants|negativePrompt|prompt|detailedPrompt)\s*"/i.test(localized)) {
    issues.push(`${pathName}: contains JSON/code-fence leakage.`);
  }

  const englishWords = getOrdinaryEnglishWords(localized);
  if (englishWords.length) {
    issues.push(`${pathName}: contains untranslated English words: ${englishWords.slice(0, 8).join(", ")}.`);
  }

  const missingTerms = collectRequiredTranslationTerms(source).filter(
    (term) => !term.zh.some((zhText) => localized.includes(zhText))
  );
  if (missingTerms.length) {
    issues.push(
      `${pathName}: missing source terms: ${missingTerms
        .map((term) => `${term.en}->${term.zh.join("/")}`)
        .slice(0, 8)
        .join(", ")}.`
    );
  }
}

function getOrdinaryEnglishWords(text) {
  const whitelist = new Set(["3D", "SDXL", "Flux", "Midjourney", "MJ"]);
  const sourceWithoutFlags = stripGenerationFlags(text);
  const matches = sourceWithoutFlags.match(/\b[a-zA-Z][a-zA-Z'-]*\b/g) || [];
  return dedupeStrings(
    matches.filter((word) => {
      const normalized = word.replace(/[^a-zA-Z]/g, "");
      if (!normalized) {
        return false;
      }
      if (/^FLAG_\d+$/i.test(normalized)) {
        return false;
      }
      return !Array.from(whitelist).some((allowed) => normalized.toLowerCase() === allowed.toLowerCase());
    })
  );
}

function stripGenerationFlags(text) {
  return String(text || "").replace(/--[a-zA-Z][a-zA-Z0-9-]*(?:[=\s]+[^\s,，。；;]+)?/g, " ");
}

function collectRequiredTranslationTermsFromBundle(promptModes, promptVariants, negativePrompt) {
  const texts = [
    promptModes?.detailed,
    promptModes?.pro,
    promptVariants?.detailed?.general,
    promptVariants?.detailed?.midjourney,
    promptVariants?.detailed?.sdxl,
    promptVariants?.detailed?.flux,
    promptVariants?.pro?.general,
    promptVariants?.pro?.midjourney,
    promptVariants?.pro?.sdxl,
    promptVariants?.pro?.flux,
    negativePrompt
  ];

  return collectRequiredTranslationTerms(texts.join(" "));
}

function collectRequiredTranslationTerms(text) {
  const source = String(text || "");
  const terms = getRequiredTranslationTermMap()
    .filter((term) => term.pattern.test(source))
    .map((term) => ({ en: term.en, zh: term.zh }));
  return dedupeTranslationTerms(terms);
}

function dedupeTranslationTerms(terms) {
  const seen = new Set();
  const result = [];
  for (const term of terms) {
    const key = term.zh[0];
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(term);
  }
  return result;
}

function getRequiredTranslationTermMap() {
  return [
    { en: "container ship", pattern: /\b(container ship|cargo ship)\b/i, zh: ["集装箱货轮", "货轮", "集装箱船"] },
    { en: "airplane", pattern: /\b(airplane|plane|aircraft|jet)\b/i, zh: ["飞机"] },
    { en: "truck", pattern: /\btruck(s)?\b/i, zh: ["卡车", "货车"] },
    { en: "ship", pattern: /\b(ship|boat|vessel)\b/i, zh: ["船", "轮船", "货轮"] },
    { en: "container", pattern: /\bcontainer(s)?\b/i, zh: ["集装箱"] },
    { en: "box", pattern: /\bbox(es)?\b/i, zh: ["箱子", "货箱"] },
    { en: "logistics", pattern: /\blogistics\b/i, zh: ["物流"] },
    { en: "port", pattern: /\b(port|harbor|dock(?:ed)?)\b/i, zh: ["港口", "码头"] },
    { en: "crane", pattern: /\bcrane(s)?\b/i, zh: ["起重机", "吊机"] },
    { en: "building", pattern: /\bbuilding(s)?\b/i, zh: ["建筑", "大楼"] },
    { en: "warehouse", pattern: /\bwarehouse(s)?\b/i, zh: ["仓库"] },
    { en: "platform", pattern: /\bplatform(s)?\b/i, zh: ["平台"] },
    { en: "satellite", pattern: /\bsatellite(s)?\b/i, zh: ["卫星"] },
    { en: "solar panels", pattern: /\bsolar panel(s)?\b/i, zh: ["太阳能板"] },
    { en: "Earth", pattern: /\bEarth\b/i, zh: ["地球"] },
    { en: "planet", pattern: /\bplanet(ary)?\b/i, zh: ["星球"] },
    { en: "cloud icon", pattern: /\bcloud icon\b/i, zh: ["云朵图标"] },
    { en: "cloud", pattern: /\bcloud\b/i, zh: ["云朵"] },
    { en: "bar chart", pattern: /\bbar chart(s)?\b/i, zh: ["柱状图"] },
    { en: "pie chart", pattern: /\bpie chart(s)?\b/i, zh: ["饼图"] },
    { en: "dashboard", pattern: /\bdashboard(s)?\b/i, zh: ["数据看板", "看板"] },
    { en: "tablet", pattern: /\btablet(s)?\b/i, zh: ["平板"] },
    { en: "screen", pattern: /\bscreen(s)?\b/i, zh: ["屏幕"] },
    { en: "interface", pattern: /\binterface(s)?\b/i, zh: ["界面"] },
    { en: "female cyborg", pattern: /\bfemale cyborg\b/i, zh: ["女性义体人"] },
    { en: "mechanical arm", pattern: /\bmechanical arm(s)?\b/i, zh: ["机械手臂"] },
    { en: "mask", pattern: /\bmask(s)?\b/i, zh: ["面罩"] },
    { en: "armor", pattern: /\barmor|armour\b/i, zh: ["装甲"] },
    { en: "white hair", pattern: /\bwhite hair\b/i, zh: ["白发"] },
    { en: "blue eyes", pattern: /\bblue eyes\b/i, zh: ["蓝眼睛"] },
    { en: "white hoodie", pattern: /\bwhite hoodie\b/i, zh: ["白色连帽衫"] }
  ];
}

function unwrapPromptJsonLeak(text) {
  const raw = stripCodeFence(String(text || "").trim());
  if (!raw || !/[{[]|```|\bjson\b/i.test(raw)) {
    return raw;
  }

  const parsed = parseModelJson(raw);
  if (parsed) {
    return String(
      parsed.proPrompt ||
        parsed.detailedPrompt ||
        parsed.prompt ||
        parsed.concisePrompt ||
        parsed.promptModes?.pro ||
        parsed.promptModes?.detailed ||
        parsed.promptModes?.concise ||
        parsed.promptVariants?.pro?.general ||
        parsed.promptVariants?.detailed?.general ||
        parsed.promptVariants?.concise?.general ||
        raw
    );
  }

  return raw.replace(/```json|```/gi, "").replace(/^\s*json\s*/i, "").trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeIncomingPromptModes(promptModes) {
  const fallback = String(promptModes?.detailed || promptModes?.concise || "").trim();
  return {
    detailed: fallback,
    pro: String(promptModes?.pro || fallback).trim()
  };
}

function normalizeIncomingPromptVariants(promptVariants, promptModes) {
  if (promptVariants?.concise || promptVariants?.detailed || promptVariants?.pro) {
    return {
      detailed: normalizeIncomingVariantRow(promptVariants.detailed || promptVariants.concise, promptModes.detailed),
      pro: normalizeIncomingVariantRow(promptVariants.pro, promptModes.pro || promptModes.detailed)
    };
  }

  return buildPromptVariantMatrix(promptModes);
}

function normalizeIncomingVariantRow(row, fallbackPrompt) {
  return {
    general: String(row?.general || fallbackPrompt || "").trim(),
    midjourney: String(row?.midjourney || fallbackPrompt || "").trim(),
    sdxl: String(row?.sdxl || fallbackPrompt || "").trim(),
    flux: String(row?.flux || fallbackPrompt || "").trim()
  };
}

function localizeTags(tags) {
  return tags.map((tag) => {
    const key = String(tag || "").trim().toLowerCase();
    return TAG_TRANSLATIONS[key] || tag;
  });
}

function containsChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

function dedupeStrings(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const normalized = String(item || "").trim();
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function normalizeConfidence(value) {
  const numberValue = Number(value);
  if (Number.isNaN(numberValue)) {
    return 0.5;
  }

  const normalized = Math.max(0, Math.min(1, numberValue));
  return normalized === 1 ? 0.95 : normalized;
}

function defaultResponseHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: defaultResponseHeaders(),
    body: JSON.stringify(payload)
  };
}

function isLegacyHttpHandler(secondArg) {
  return Boolean(secondArg && typeof secondArg.setStatusCode === "function");
}

function parseFc3Event(event) {
  if (Buffer.isBuffer(event)) {
    return JSON.parse(event.toString("utf8"));
  }
  if (typeof event === "string") {
    return JSON.parse(event);
  }
  return event || {};
}

function decodeEventBody(eventObject) {
  if (!eventObject || eventObject.body == null) {
    return Buffer.alloc(0);
  }

  if (eventObject.isBase64Encoded) {
    return Buffer.from(eventObject.body, "base64");
  }

  return Buffer.from(String(eventObject.body), "utf8");
}

function toBuffer(value) {
  if (!value) {
    return Buffer.alloc(0);
  }

  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function normalizeHeaderKeys(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[String(key).toLowerCase()] = value;
  }
  return normalized;
}

function normalizePath(pathValue) {
  const raw = String(pathValue || "/").split("?")[0].trim();
  if (!raw) {
    return "/";
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function pathMatches(actualPath, expectedSuffix) {
  return actualPath === expectedSuffix || actualPath.endsWith(expectedSuffix);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

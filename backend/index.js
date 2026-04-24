"use strict";

const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL_NAME = "glm-4v-flash";
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
  const promptModes = normalizeIncomingPromptModes(body.promptModes);
  const promptVariants = normalizeIncomingPromptVariants(body.promptVariants, promptModes);
  const negativePrompt = String(body.negativePrompt || "").trim();
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
    concise: prompt,
    detailed: prompt,
    pro: prompt
  };
  const promptVariants = buildPromptVariantMatrix(promptModes);
  const localizedBundle = await buildLocalizedPromptBundle(promptModes, promptVariants, negativePrompt);
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
    ...localizedBundle,
    metadata
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
                "Analyze this image and reconstruct AI-generation prompts in three density levels. " +
                "Return strict JSON with keys: sceneType, concisePrompt, detailedPrompt, proPrompt, negativePrompt, styleTags, subjectTags, styleProfile, reasoning, confidence. " +
                `sceneType must be one of: ${SCENE_TYPES.join(", ")}. ` +
                "All prompt fields must be English generation-ready prompts, not plain captions. " +
                "concisePrompt should be 18 to 35 English words and cover the essentials only. " +
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
    const localizedBundle = await buildLocalizedPromptBundle(
      fallbackModes,
      fallbackVariants,
      "blurry, low quality, bad anatomy, extra fingers, distorted face"
    );
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
      ...localizedBundle
    };
  }

  const rawPromptTexts = [
    parsed.concisePrompt,
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
  const localizedBundle = await buildLocalizedPromptBundle(promptModes, promptVariants, negativePrompt);

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
    ...localizedBundle
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
  const conciseSeed = String(parsed.concisePrompt || parsed.prompt || "").trim();
  const detailedSeed = String(parsed.detailedPrompt || parsed.prompt || conciseSeed).trim();
  const proSeed =
    String(parsed.proPrompt || parsed.detailedPrompt || parsed.prompt || detailedSeed).trim();

  const concise = tightenPrompt(finalizePromptText(enrichPrompt(conciseSeed, styleTags, subjectTags, styleProfile, sceneType), sceneType), 38);
  const detailed = finalizePromptText(enrichPrompt(detailedSeed, styleTags, subjectTags, styleProfile, sceneType), sceneType);
  const pro = finalizePromptText(enrichProfessionalPrompt(proSeed, styleTags, subjectTags, styleProfile, sceneType), sceneType);

  return {
    concise,
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
    concise: tightenPrompt(detailed, 38),
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
    concise: buildPromptVariants(promptModes.concise || ""),
    detailed: buildPromptVariants(promptModes.detailed || promptModes.concise || ""),
    pro: buildPromptVariants(promptModes.pro || promptModes.detailed || promptModes.concise || "")
  };
}

async function buildLocalizedPromptBundle(promptModes, promptVariants, negativePrompt) {
  const englishBundle = {
    localizedPromptModes: { ...promptModes },
    localizedPromptVariants: clonePromptVariantMatrix(promptVariants),
    localizedNegativePrompt: negativePrompt || ""
  };

  const promptTexts = [
    promptModes?.concise,
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
    const mergedBundle = {
      localizedPromptModes: {
        concise: translated.promptModes?.concise || promptModes.concise || "",
        detailed: translated.promptModes?.detailed || promptModes.detailed || promptModes.concise || "",
        pro: translated.promptModes?.pro || promptModes.pro || promptModes.detailed || promptModes.concise || ""
      },
      localizedPromptVariants: {
        concise: {
          general: translated.promptVariants?.concise?.general || promptVariants.concise.general || "",
          midjourney: translated.promptVariants?.concise?.midjourney || promptVariants.concise.midjourney || "",
          sdxl: translated.promptVariants?.concise?.sdxl || promptVariants.concise.sdxl || "",
          flux: translated.promptVariants?.concise?.flux || promptVariants.concise.flux || ""
        },
        detailed: {
          general: translated.promptVariants?.detailed?.general || promptVariants.detailed.general || "",
          midjourney: translated.promptVariants?.detailed?.midjourney || promptVariants.detailed.midjourney || "",
          sdxl: translated.promptVariants?.detailed?.sdxl || promptVariants.detailed.sdxl || "",
          flux: translated.promptVariants?.detailed?.flux || promptVariants.detailed.flux || ""
        },
        pro: {
          general: translated.promptVariants?.pro?.general || promptVariants.pro.general || "",
          midjourney: translated.promptVariants?.pro?.midjourney || promptVariants.pro.midjourney || "",
          sdxl: translated.promptVariants?.pro?.sdxl || promptVariants.pro.sdxl || "",
          flux: translated.promptVariants?.pro?.flux || promptVariants.pro.flux || ""
        }
      },
      localizedNegativePrompt: translated.negativePrompt || negativePrompt || ""
    };

    const normalizedBundle = normalizeLocalizedPromptBundle(mergedBundle);
    const fallbackBundle = buildLocalizedPromptBundleFallback(promptModes, promptVariants, negativePrompt);
    const preferredBundle = pickCleanerLocalizedBundle(normalizedBundle, fallbackBundle);

    if (bundleHasChinese(preferredBundle)) {
      return preferredBundle;
    }

    return fallbackBundle;
  } catch (error) {
    console.error("Prompt localization failed:", error);
    return buildLocalizedPromptBundleFallback(promptModes, promptVariants, negativePrompt);
  }
}

async function translatePromptBundleWithGlm(apiKey, promptModes, promptVariants, negativePrompt) {
  const response = await fetch(ZHIPU_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      temperature: 0.15,
      max_tokens: 1400,
      messages: [
        {
          role: "system",
          content:
            "You translate AI image-generation prompts from English to Simplified Chinese. " +
            "Return strict JSON only with keys promptModes, promptVariants, negativePrompt. " +
            "Keep the original structure exactly. Preserve Midjourney and model flags like --ar 3:4, --v 7, SDXL, Flux, CGI, 3D, cyberpunk, sci-fi when needed. " +
            "Use concise, natural Chinese prompt phrasing, but do not translate command flags."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              promptModes,
              promptVariants,
              negativePrompt
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

  return parsed;
}

function clonePromptVariantMatrix(promptVariants) {
  return {
    concise: { ...promptVariants.concise },
    detailed: { ...promptVariants.detailed },
    pro: { ...promptVariants.pro }
  };
}

function bundleHasChinese(bundle) {
  return Boolean(
    containsChinese(bundle.localizedPromptModes?.concise) ||
      containsChinese(bundle.localizedPromptModes?.detailed) ||
      containsChinese(bundle.localizedPromptModes?.pro) ||
      containsChinese(bundle.localizedNegativePrompt)
  );
}

function buildLocalizedPromptBundleFallback(promptModes, promptVariants, negativePrompt) {
  return normalizeLocalizedPromptBundle({
    localizedPromptModes: {
      concise: fallbackTranslatePromptText(promptModes.concise || ""),
      detailed: fallbackTranslatePromptText(promptModes.detailed || promptModes.concise || ""),
      pro: fallbackTranslatePromptText(promptModes.pro || promptModes.detailed || promptModes.concise || "")
    },
    localizedPromptVariants: {
      concise: fallbackTranslateVariantRow(promptVariants.concise),
      detailed: fallbackTranslateVariantRow(promptVariants.detailed),
      pro: fallbackTranslateVariantRow(promptVariants.pro)
    },
    localizedNegativePrompt: fallbackTranslatePromptText(negativePrompt || "")
  });
}

function fallbackTranslateVariantRow(row) {
  return {
    general: fallbackTranslatePromptText(row?.general || ""),
    midjourney: fallbackTranslatePromptText(row?.midjourney || ""),
    sdxl: fallbackTranslatePromptText(row?.sdxl || ""),
    flux: fallbackTranslatePromptText(row?.flux || "")
  };
}

function fallbackTranslatePromptText(text) {
  let output = String(text || "");
  if (!output) {
    return "";
  }

  const protectedFlags = [];
  output = output.replace(/--[a-zA-Z0-9:-]+(?:\s+[a-zA-Z0-9:./-]+)?/g, (match) => {
    const token = `__FLAG_${protectedFlags.length}__`;
    protectedFlags.push(match);
    return token;
  });

  const replacements = [
    ["upper-body three-quarter portrait", "上半身三分之四侧身人像"],
    ["upper-body bust portrait", "上半身胸像"],
    ["close-up portrait", "近景人像特写"],
    ["centered object composition", "主体居中构图"],
    ["clean industrial composition", "干净的工业场景构图"],
    ["clean architectural composition", "干净的建筑构图"],
    ["balanced interior composition", "平衡的室内构图"],
    ["wide scenic composition", "宽幅风景构图"],
    ["clean poster composition", "干净的海报构图"],
    ["side-angle upper-body portrait", "侧角度上半身人像"],
    ["three-quarter side profile", "三分之四侧脸视角"],
    ["cyberpunk aesthetic", "赛博朋克美学"],
    ["sci-fi character design", "科幻角色设计"],
    ["mecha-inspired armor design", "机甲感装甲设计"],
    ["cybernetic body details", "义体机械细节"],
    ["clean CGI render", "干净的 CGI 渲染"],
    ["stylized 3D render", "风格化 3D 渲染"],
    ["doll-like 3D render", "人偶感 3D 渲染"],
    ["anime-inspired 3D render", "动漫感 3D 渲染"],
    ["cool-toned palette", "冷色调配色"],
    ["soft lighting", "柔和打光"],
    ["soft clean surfaces", "干净平滑的表面"],
    ["smooth clean surfaces", "平滑干净的表面"],
    ["matte fabric texture", "哑光布料质感"],
    ["industrial scene", "工业场景"],
    ["clean geometric forms", "干净的几何造型"],
    ["architectural visualization", "建筑可视化效果"],
    ["graphic design composition", "平面设计式构图"],
    ["cute character styling", "可爱角色风格"],
    ["doll-like character", "人偶感角色"],
    ["high detail", "高细节"],
    ["highly detailed", "高细节"],
    ["best quality", "高质量"],
    ["masterpiece", "杰作级质感"],
    ["precise forms", "精准造型"],
    ["rich material detail", "丰富材质细节"],
    ["soft global illumination", "柔和全局光照"],
    ["crisp render quality", "清晰渲染质感"],
    ["polished stylization", "精修风格化处理"],
    ["refined lighting", "精致光照"],
    ["ultra detailed", "超高细节"],
    ["cinematic composition", "电影感构图"],
    ["clean composition", "干净构图"],
    ["female cyborg", "女性义体人"],
    ["mechanical arm", "机械手臂"],
    ["robotic armor", "机械装甲"],
    ["futuristic mask", "未来感面罩"],
    ["high-tech suit", "高科技战衣"],
    ["white hair", "白发"],
    ["blue eyes", "蓝眼睛"],
    ["pink cheeks", "粉色脸颊"],
    ["pink blush", "粉色腮红"],
    ["white hoodie", "白色连帽衫"],
    ["light blue background", "浅蓝色背景"],
    ["dark background", "深色背景"],
    ["soft light blue background", "柔和浅蓝背景"],
    ["satellite", "卫星"],
    ["solar panels", "太阳能板"],
    ["orbiting Earth at night", "在夜晚环绕地球运行"],
    ["container ship", "集装箱货轮"],
    ["port", "港口"],
    ["crane", "起重机"],
    ["building", "建筑"],
    ["vehicle", "交通工具"],
    ["character", "角色"],
    ["portrait", "人像"],
    ["background", "背景"],
    ["cool tones", "冷色调"],
    ["dramatic lighting", "戏剧化光照"],
    ["realistic CGI", "写实 CGI"],
    ["realistic rendering", "写实渲染"],
    ["3D rendering", "3D 渲染"],
    ["3D render", "3D 渲染"],
    ["CGI render", "CGI 渲染"],
    ["doll-like", "人偶感"],
    ["cyberpunk", "赛博朋克"],
    ["sci-fi", "科幻"],
    ["futuristic", "未来感"],
    ["high-tech", "高科技"],
    ["blurred", "模糊"],
    ["blurry", "模糊"],
    ["low quality", "低质量"],
    ["bad anatomy", "结构错误"],
    ["extra fingers", "多余手指"],
    ["distorted face", "脸部畸形"],
    ["warped geometry", "几何结构扭曲"],
    ["broken perspective", "透视错误"],
    ["messy composition", "构图杂乱"],
    ["low detail", "细节不足"]
  ];

  for (const [from, to] of replacements.sort((a, b) => b[0].length - a[0].length)) {
    output = output.replace(new RegExp(escapeRegExp(from), "gi"), to);
  }

  output = output
    .replace(/\bwith\b/gi, "，带有")
    .replace(/\bagainst\b/gi, "，背景为")
    .replace(/\bwearing\b/gi, "，穿着")
    .replace(/\band\b/gi, "，以及")
    .replace(/\bof\b/gi, "的")
    .replace(/\bfrom\b/gi, "从")
    .replace(/\bview\b/gi, "视角")
    .replace(/\bcomposition\b/gi, "构图")
    .replace(/\brendered in\b/gi, "渲染风格为")
    .replace(/\s+,/g, "，")
    .replace(/,\s*/g, "，")
    .replace(/\s{2,}/g, " ")
    .trim();

  output = output.replace(/__FLAG_(\d+)__/g, (_, index) => protectedFlags[Number(index)] || "");
  return normalizeLocalizedPromptText(output);
}

function normalizeLocalizedPromptBundle(bundle) {
  return {
    localizedPromptModes: {
      concise: normalizeLocalizedPromptText(bundle.localizedPromptModes?.concise || ""),
      detailed: normalizeLocalizedPromptText(bundle.localizedPromptModes?.detailed || ""),
      pro: normalizeLocalizedPromptText(bundle.localizedPromptModes?.pro || "")
    },
    localizedPromptVariants: {
      concise: normalizeLocalizedVariantRow(bundle.localizedPromptVariants?.concise),
      detailed: normalizeLocalizedVariantRow(bundle.localizedPromptVariants?.detailed),
      pro: normalizeLocalizedVariantRow(bundle.localizedPromptVariants?.pro)
    },
    localizedNegativePrompt: normalizeLocalizedPromptText(bundle.localizedNegativePrompt || "")
  };
}

function normalizeLocalizedVariantRow(row) {
  return {
    general: normalizeLocalizedPromptText(row?.general || ""),
    midjourney: normalizeLocalizedPromptText(row?.midjourney || ""),
    sdxl: normalizeLocalizedPromptText(row?.sdxl || ""),
    flux: normalizeLocalizedPromptText(row?.flux || "")
  };
}

function normalizeLocalizedPromptText(text) {
  let output = String(text || "").trim();
  if (!output) {
    return "";
  }

  const protectedFlags = [];
  output = output.replace(/--[a-zA-Z0-9:-]+(?:\s+[a-zA-Z0-9:./-]+)?/g, (match) => {
    const token = `__FLAG_${protectedFlags.length}__`;
    protectedFlags.push(match);
    return token;
  });

  const phraseReplacements = [
    ["character is against a dark background", "背景为深色背景"],
    ["set against a dark background", "背景为深色背景"],
    ["set against a soft light blue background", "背景为柔和浅蓝背景"],
    ["with form from a side angle with focus on her torso and upper body", "侧面视角，重点展示躯干与上半身"],
    ["with focus on her torso and upper body", "重点展示躯干与上半身"],
    ["lighting highlighting metallic sheen of her armor and intricate details of her mechanical components", "光照突出装甲的金属光泽与机械部件的复杂细节"],
    ["lighting highlights contours and metallic surfaces of her armor", "光照突出装甲的轮廓与金属表面"],
    ["dynamic pose", "动态姿态"],
    ["sleek black mask covering her face", "覆盖面部的流线型黑色面罩"],
    ["a high-tech bodysuit", "高科技紧身战衣"],
    ["high-tech bodysuit", "高科技紧身战衣"],
    ["yellow and black color scheme", "黄黑配色"],
    ["black and yellow color scheme", "黑黄配色"],
    ["high-tech mask", "高科技面罩"],
    ["sleek black mask", "流线型黑色面罩"],
    ["mechanical arm", "机械手臂"],
    ["futuristic design", "未来感设计"],
    ["futuristic mask", "未来感面罩"],
    ["dark background", "深色背景"],
    ["side angle", "侧面视角"],
    ["focus on her torso and upper body", "重点展示躯干与上半身"],
    ["focus on torso and upper body", "重点展示躯干与上半身"],
    ["metallic sheen", "金属光泽"],
    ["intricate details", "复杂细节"],
    ["mechanical components", "机械部件"],
    ["clean CGI render", "干净的 CGI 渲染"],
    ["cyberpunk aesthetic", "赛博朋克美学"],
    ["cybernetic body details", "义体机械细节"],
    ["sci-fi character design", "科幻角色设计"],
    ["high detail", "高细节"],
    ["doll-like 3D render", "人偶感 3D 渲染"],
    ["doll-like character", "人偶感角色"],
    ["cute character styling", "可爱角色风格"],
    ["close-up portrait view", "近景人像视角"],
    ["close-up portrait", "近景人像特写"],
    ["soft light blue background", "柔和浅蓝背景"],
    ["light blue background", "浅蓝色背景"],
    ["white hoodie", "白色连帽衫"],
    ["white hair", "白发"],
    ["blue eyes", "蓝眼睛"],
    ["pink cheeks", "粉色脸颊"],
    ["pink blush", "粉色腮红"],
    ["solar panels", "太阳能板"],
    ["orbiting Earth at night", "在夜晚环绕地球运行"],
    ["satellite", "卫星"],
    ["container ship", "集装箱货轮"],
    ["realistic CGI", "写实 CGI"],
    ["realistic rendering", "写实渲染"],
    ["3D rendered", "3D 渲染"],
    ["3D render", "3D 渲染"],
    ["3D rendering", "3D 渲染"],
    ["illustration", "插画"],
    ["cyberpunk", "赛博朋克"],
    ["sci-fi", "科幻"],
    ["futuristic", "未来感"],
    ["cgi", "CGI"]
  ];

  for (const [from, to] of phraseReplacements.sort((a, b) => b[0].length - a[0].length)) {
    output = output.replace(new RegExp(escapeRegExp(from), "gi"), to);
  }

  const wordReplacements = [
    ["design", "设计"],
    ["yellow", "黄色"],
    ["black", "黑色"],
    ["mask", "面罩"],
    ["armor", "装甲"],
    ["armored suit", "装甲战衣"],
    ["suit", "战衣"],
    ["bodysuit", "紧身战衣"],
    ["torso", "躯干"],
    ["upper body", "上半身"],
    ["lighting", "光照"],
    ["highlighting", "突出"],
    ["highlight", "突出"],
    ["form", "轮廓"],
    ["attire", "服装"],
    ["pose", "姿态"],
    ["dynamic", "动态"],
    ["strength", "力量感"],
    ["agility", "敏捷感"],
    ["face", "面部"],
    ["body", "身体"],
    ["components", "部件"],
    ["textures", "纹理"],
    ["texture", "纹理"],
    ["color scheme", "配色"],
    ["focus", "聚焦"],
    ["patterns", "纹样"],
    ["smooth", "平滑"],
    ["glossy", "光泽"],
    ["dramatic", "戏剧化"],
    ["soft", "柔和"],
    ["clean", "干净"],
    ["female cyborg", "女性义体人"],
    ["cyborg", "义体人"],
    ["female", "女性"],
    ["character", "角色"]
  ];

  for (const [from, to] of wordReplacements.sort((a, b) => b[0].length - a[0].length)) {
    output = output.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi"), to);
  }

  output = output
    .replace(/\b(a|an|the)\b/gi, "")
    .replace(/\b(her|his|their|she|he|they|it)\b/gi, "")
    .replace(/\b(is|are|was|were|be|being|been|having|with|and|of|from|to|that)\b/gi, "，")
    .replace(/\b(on|in|at|by|for|into|over|under|below|above)\b/gi, "，")
    .replace(/[,:;]+/g, "，")
    .replace(/\s+/g, " ")
    .replace(/\s*，\s*/g, "，")
    .replace(/，{2,}/g, "，")
    .replace(/focus on/gi, "聚焦于")
    .replace(/highlighting/gi, "突出")
    .replace(/color scheme/gi, "配色")
    .replace(/design/gi, "设计")
    .replace(/\bcharacter\b/gi, "")
    .replace(/\bstands?\b/gi, "")
    .replace(/\bappears?\b/gi, "")
    .replace(/^\s*，/, "")
    .replace(/，\s*$/, "")
    .trim();

  output = output.replace(/__FLAG_(\d+)__/g, (_, index) => protectedFlags[Number(index)] || "");
  return output;
}

function fallbackTranslatePromptText(text) {
  let output = String(text || "").trim();
  if (!output) {
    return "";
  }

  const protectedFlags = [];
  output = output.replace(/--[a-zA-Z0-9:-]+(?:\s+[a-zA-Z0-9:./-]+)?/g, (match) => {
    const token = `__FLAG_${protectedFlags.length}__`;
    protectedFlags.push(match);
    return token;
  });

  output = applyLocalizedReplacements(output, getLocalizedPhraseReplacements());
  output = applyLocalizedWordReplacements(output, getLocalizedWordReplacements());
  output = output.replace(/__FLAG_(\d+)__/g, (_, index) => protectedFlags[Number(index)] || "");

  return normalizeLocalizedPromptText(output);
}

function normalizeLocalizedPromptText(text) {
  let output = String(text || "").trim();
  if (!output) {
    return "";
  }

  const protectedFlags = [];
  output = output.replace(/--[a-zA-Z0-9:-]+(?:\s+[a-zA-Z0-9:./-]+)?/g, (match) => {
    const token = `__FLAG_${protectedFlags.length}__`;
    protectedFlags.push(match);
    return token;
  });

  output = applyLocalizedReplacements(output, getLocalizedPhraseReplacements());
  output = applyLocalizedWordReplacements(output, getLocalizedWordReplacements());

  output = output
    .replace(/\b(a|an|the)\b/gi, " ")
    .replace(/\b(her|his|their|she|he|they|it)\b/gi, " ")
    .replace(/\b(is|are|was|were|be|being|been|having)\b/gi, " ")
    .replace(/\b(with|and|of|from|to|that|on|in|at|by|for|into|over|under|below|above)\b/gi, "，")
    .replace(/[,:;]+/g, "，")
    .replace(/，\s*，+/g, "，")
    .replace(/\s*，\s*/g, "，")
    .replace(/\s+/g, " ")
    .replace(/^，+|，+$/g, "")
    .trim();

  output = output.replace(/__FLAG_(\d+)__/g, (_, index) => protectedFlags[Number(index)] || "");

  return output
    .replace(/\b(stands?|appears?)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/，{2,}/g, "，")
    .replace(/^，+|，+$/g, "")
    .trim();
}

function getLocalizedPhraseReplacements() {
  return [
    ["with form from a side angle with focus on her torso and upper body", "侧面视角，重点展示躯干与上半身"],
    ["lighting highlighting metallic sheen of her armor and intricate details of her mechanical components", "光照突出装甲的金属光泽与机械部件的复杂细节"],
    ["lighting highlights contours and metallic surfaces of her armor", "光照突出装甲轮廓与金属表面"],
    ["character is against a dark background", "背景为深色背景"],
    ["set against a dark background", "背景为深色背景"],
    ["set against a soft light blue background", "背景为柔和浅蓝背景"],
    ["with focus on her torso and upper body", "重点展示躯干与上半身"],
    ["focus on her torso and upper body", "重点展示躯干与上半身"],
    ["focus on torso and upper body", "重点展示躯干与上半身"],
    ["side-angle upper-body portrait", "侧角度上半身人像"],
    ["upper-body three-quarter portrait", "上半身四分之三侧身人像"],
    ["upper-body bust portrait", "上半身胸像人像"],
    ["three-quarter side profile", "四分之三侧面视角"],
    ["close-up portrait view", "近景人像视角"],
    ["close-up portrait", "近景人像特写"],
    ["centered object composition", "主体居中构图"],
    ["clean industrial composition", "干净的工业场景构图"],
    ["clean architectural composition", "干净的建筑构图"],
    ["balanced interior composition", "平衡的室内构图"],
    ["wide scenic composition", "宽幅风景构图"],
    ["clean poster composition", "干净的海报构图"],
    ["clean composition", "干净构图"],
    ["clean studio background", "干净的纯色背景"],
    ["clean geometric forms", "干净的几何造型"],
    ["industrial scene", "工业场景"],
    ["architectural visualization", "建筑可视化效果"],
    ["graphic design composition", "平面设计式构图"],
    ["cyberpunk aesthetic", "赛博朋克美学"],
    ["sci-fi character design", "科幻角色设计"],
    ["mecha-inspired armor design", "机甲感装甲设计"],
    ["cybernetic body details", "义体机械细节"],
    ["doll-like 3D render", "人偶感3D渲染"],
    ["anime-inspired 3D render", "动漫感3D渲染"],
    ["stylized 3D render", "风格化3D渲染"],
    ["clean CGI render", "干净的CGI渲染"],
    ["realistic CGI", "写实CGI"],
    ["realistic rendering", "写实渲染"],
    ["3D rendered", "3D渲染"],
    ["3D rendering", "3D渲染"],
    ["3D render", "3D渲染"],
    ["CGI render", "CGI渲染"],
    ["cool-toned palette", "冷色调配色"],
    ["soft light blue background", "柔和浅蓝背景"],
    ["light blue background", "浅蓝色背景"],
    ["dark background", "深色背景"],
    ["soft clean surfaces", "干净平滑的表面"],
    ["smooth clean surfaces", "平滑干净的表面"],
    ["matte fabric texture", "哑光布料质感"],
    ["soft global illumination", "柔和全局光照"],
    ["rich material detail", "丰富材质细节"],
    ["crisp render quality", "清晰渲染质感"],
    ["polished stylization", "精修风格化处理"],
    ["refined lighting", "精致光照"],
    ["cinematic composition", "电影感构图"],
    ["cute character styling", "可爱角色风格"],
    ["doll-like character", "人偶感角色"],
    ["high-tech bodysuit", "高科技紧身战衣"],
    ["a high-tech bodysuit", "高科技紧身战衣"],
    ["yellow and black armored bodysuit", "黄黑配色装甲式紧身战衣"],
    ["high-tech suit", "高科技战衣"],
    ["exposed mechanical arm", "外露机械手臂"],
    ["intricate mechanical detailing", "复杂机械细节"],
    ["sleek black mask covering her face", "覆盖面部的流线型黑色面罩"],
    ["sleek black mask", "流线型黑色面罩"],
    ["high-tech mask", "高科技面罩"],
    ["futuristic mask", "未来感面罩"],
    ["futuristic design", "未来感设计"],
    ["yellow and black color scheme", "黄黑配色"],
    ["black and yellow color scheme", "黑黄配色"],
    ["female cyborg", "女性义体人"],
    ["mechanical arm", "机械手臂"],
    ["robotic armor", "机械装甲"],
    ["white hoodie", "白色连帽衫"],
    ["white hair", "白发"],
    ["blue eyes", "蓝眼睛"],
    ["pink cheeks", "粉色脸颊"],
    ["pink blush", "粉色腮红"],
    ["orbiting Earth at night", "在夜晚环绕地球运行"],
    ["solar panels", "太阳能板"],
    ["container ship", "集装箱货轮"],
    ["satellite", "卫星"],
    ["crane", "起重机"],
    ["building", "建筑"],
    ["port", "港口"],
    ["high detail", "高细节"],
    ["highly detailed", "高细节"],
    ["ultra detailed", "超高细节"],
    ["best quality", "高质量"],
    ["masterpiece", "杰作级质感"],
    ["precise forms", "精准造型"],
    ["soft lighting", "柔和打光"],
    ["dramatic lighting", "戏剧化光照"],
    ["dynamic pose", "动态姿态"],
    ["metallic sheen", "金属光泽"],
    ["intricate details", "复杂细节"],
    ["mechanical components", "机械部件"],
    ["deep space background", "深空背景"]
  ];
}

function getLocalizedWordReplacements() {
  return [
    ["illustration", "插画"],
    ["cyberpunk", "赛博朋克"],
    ["sci-fi", "科幻"],
    ["futuristic", "未来感"],
    ["high-tech", "高科技"],
    ["design", "设计"],
    ["yellow", "黄色"],
    ["black", "黑色"],
    ["mask", "面罩"],
    ["armor", "装甲"],
    ["armored", "装甲式"],
    ["suit", "战衣"],
    ["bodysuit", "紧身战衣"],
    ["wearing", "穿着"],
    ["exposed", "外露"],
    ["sleek", "流线型"],
    ["torso", "躯干"],
    ["upper body", "上半身"],
    ["lighting", "光照"],
    ["highlighting", "突出"],
    ["highlight", "突出"],
    ["form", "轮廓"],
    ["attire", "服装"],
    ["pose", "姿态"],
    ["dynamic", "动态"],
    ["strength", "力量感"],
    ["agility", "敏捷感"],
    ["face", "面部"],
    ["body", "身体"],
    ["components", "部件"],
    ["textures", "纹理"],
    ["texture", "纹理"],
    ["patterns", "纹样"],
    ["smooth", "平滑"],
    ["glossy", "光泽"],
    ["dramatic", "戏剧化"],
    ["soft", "柔和"],
    ["clean", "干净"],
    ["cyborg", "义体人"],
    ["female", "女性"],
    ["character", "角色"],
    ["composition", "构图"],
    ["color scheme", "配色"],
    ["focus", "聚焦"],
    ["realistic", "写实"],
    ["vehicle", "交通工具"],
    ["portrait", "人像"],
    ["background", "背景"],
    ["cool tones", "冷色调"],
    ["blurry", "模糊"],
    ["blurred", "模糊"],
    ["low quality", "低质量"],
    ["bad anatomy", "结构错误"],
    ["extra fingers", "多余手指"],
    ["distorted face", "脸部畸形"],
    ["warped geometry", "几何结构扭曲"],
    ["broken perspective", "透视错误"],
    ["messy composition", "构图杂乱"],
    ["low detail", "细节不足"]
  ];
}

function applyLocalizedReplacements(text, replacements) {
  let output = String(text || "");
  for (const [from, to] of replacements.sort((a, b) => b[0].length - a[0].length)) {
    output = output.replace(new RegExp(escapeRegExp(from), "gi"), to);
  }
  return output;
}

function applyLocalizedWordReplacements(text, replacements) {
  let output = String(text || "");
  for (const [from, to] of replacements.sort((a, b) => b[0].length - a[0].length)) {
    output = output.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi"), to);
  }
  return output;
}

function fallbackTranslatePromptText(text) {
  let output = String(text || "").trim();
  if (!output) {
    return "";
  }

  const protectedFlags = [];
  output = output.replace(/--[a-zA-Z0-9:-]+(?:\s+[a-zA-Z0-9:./-]+)?/g, (match) => {
    const token = `__FLAG_${protectedFlags.length}__`;
    protectedFlags.push(match);
    return token;
  });

  output = applyLocalizedReplacements(output, getLocalizedPhraseReplacements());
  output = applyLocalizedWordReplacements(output, getLocalizedWordReplacements());
  output = output.replace(/__FLAG_(\d+)__/g, (_, index) => protectedFlags[Number(index)] || "");

  return normalizeLocalizedPromptText(output);
}

function normalizeLocalizedPromptText(text) {
  let output = String(text || "").trim();
  if (!output) {
    return "";
  }

  const protectedFlags = [];
  output = output.replace(/--[a-zA-Z0-9:-]+(?:\s+[a-zA-Z0-9:./-]+)?/g, (match) => {
    const token = `__FLAG_${protectedFlags.length}__`;
    protectedFlags.push(match);
    return token;
  });

  output = applyLocalizedReplacements(output, getLocalizedPhraseReplacements());
  output = applyLocalizedWordReplacements(output, getLocalizedWordReplacements());

  output = output
    .replace(/\b(a|an|the)\b/gi, " ")
    .replace(/\b(her|his|their|she|he|they|it)\b/gi, " ")
    .replace(/\b(is|are|was|were|be|being|been|having)\b/gi, " ")
    .replace(/\b(with|and|of|from|to|that|on|in|at|by|for|into|over|under|below|above)\b/gi, "，")
    .replace(/[,:;]+/g, "，")
    .replace(/，\s*，+/g, "，")
    .replace(/\s*，\s*/g, "，")
    .replace(/\s+/g, " ")
    .replace(/^，+|，+$/g, "")
    .trim();

  output = output.replace(/__FLAG_(\d+)__/g, (_, index) => protectedFlags[Number(index)] || "");
  output = stripResidualEnglish(output);

  return output
    .replace(/\b(stands?|appears?)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/，{2,}/g, "，")
    .replace(/^，+|，+$/g, "")
    .trim();
}

function getLocalizedPhraseReplacements() {
  return [
    ["with form from a side angle with focus on her torso and upper body", "侧面视角，重点展示躯干与上半身"],
    ["lighting highlighting metallic sheen of her armor and intricate details of her mechanical components", "光照突出装甲的金属光泽与机械部件的复杂细节"],
    ["lighting highlights contours and metallic surfaces of her armor", "光照突出装甲轮廓与金属表面"],
    ["character's outfit includes", "角色服装包含"],
    ["character outfit includes", "角色服装包含"],
    ["character is against a dark background", "背景为深色背景"],
    ["set against a dark background", "背景为深色背景"],
    ["set against a soft light blue background", "背景为柔和浅蓝背景"],
    ["with focus on her torso and upper body", "重点展示躯干与上半身"],
    ["focus on her torso and upper body", "重点展示躯干与上半身"],
    ["focus on torso and upper body", "重点展示躯干与上半身"],
    ["side-angle upper-body portrait", "侧角度上半身人像"],
    ["upper-body three-quarter portrait", "上半身四分之三侧身人像"],
    ["upper-body bust portrait", "上半身胸像人像"],
    ["upper-body portrait", "上半身人像"],
    ["three-quarter side profile", "四分之三侧面视角"],
    ["close-up portrait view", "近景人像视角"],
    ["close-up portrait", "近景人像特写"],
    ["centered object composition", "主体居中构图"],
    ["clean industrial composition", "干净的工业场景构图"],
    ["clean architectural composition", "干净的建筑构图"],
    ["balanced interior composition", "平衡的室内构图"],
    ["wide scenic composition", "宽幅风景构图"],
    ["clean poster composition", "干净的海报构图"],
    ["clean composition", "干净构图"],
    ["clean studio background", "干净的纯色背景"],
    ["clean geometric forms", "干净的几何造型"],
    ["industrial scene", "工业场景"],
    ["architectural visualization", "建筑可视化效果"],
    ["graphic design composition", "平面设计式构图"],
    ["cyberpunk aesthetic", "赛博朋克美学"],
    ["sci-fi character design", "科幻角色设计"],
    ["mecha-inspired armor design", "机甲感装甲设计"],
    ["cybernetic body details", "义体机械细节"],
    ["cybernetic enhancements", "义体强化细节"],
    ["doll-like 3D render", "人偶感3D渲染"],
    ["anime-inspired 3D render", "动漫感3D渲染"],
    ["stylized 3D render", "风格化3D渲染"],
    ["clean CGI render", "干净的CGI渲染"],
    ["realistic CGI", "写实CGI"],
    ["realistic rendering", "写实渲染"],
    ["3D rendered", "3D渲染"],
    ["3D rendering", "3D渲染"],
    ["3D render", "3D渲染"],
    ["CGI render", "CGI渲染"],
    ["cool-toned palette", "冷色调配色"],
    ["soft light blue background", "柔和浅蓝背景"],
    ["light blue background", "浅蓝色背景"],
    ["dark background", "深色背景"],
    ["soft clean surfaces", "干净平滑的表面"],
    ["smooth clean surfaces", "平滑干净的表面"],
    ["matte fabric texture", "哑光布料质感"],
    ["soft global illumination", "柔和全局光照"],
    ["rich material detail", "丰富材质细节"],
    ["crisp render quality", "清晰渲染质感"],
    ["polished stylization", "精修风格化处理"],
    ["refined lighting", "精致光照"],
    ["cinematic composition", "电影感构图"],
    ["cute character styling", "可爱角色风格"],
    ["doll-like character", "人偶感角色"],
    ["high-tech bodysuit", "高科技紧身战衣"],
    ["a high-tech bodysuit", "高科技紧身战衣"],
    ["yellow and black armored bodysuit", "黄黑配色装甲式紧身战衣"],
    ["high-tech suit", "高科技战衣"],
    ["exposed mechanical arm", "外露机械手臂"],
    ["intricate mechanical detailing", "复杂机械细节"],
    ["intricate mechanical details", "复杂机械细节"],
    ["intricate details", "复杂细节"],
    ["intricate designs", "复杂设计细节"],
    ["glowing elements", "发光元素"],
    ["advanced technology", "先进科技感"],
    ["suggesting movement", "带有运动感"],
    ["reflective surfaces", "反光表面"],
    ["dramatic mood", "戏剧化氛围"],
    ["highlights contours", "突出轮廓"],
    ["readiness", "蓄势待发感"],
    ["action", "动作张力"],
    ["sleek black mask covering her face", "覆盖面部的流线型黑色面罩"],
    ["sleek black mask", "流线型黑色面罩"],
    ["high-tech mask", "高科技面罩"],
    ["futuristic mask", "未来感面罩"],
    ["futuristic design", "未来感设计"],
    ["yellow and black color scheme", "黄黑配色"],
    ["black and yellow color scheme", "黑黄配色"],
    ["female cyborg", "女性义体人"],
    ["mechanical arm", "机械手臂"],
    ["robotic armor", "机械装甲"],
    ["white hoodie", "白色连帽衫"],
    ["white hair", "白发"],
    ["blue eyes", "蓝眼睛"],
    ["pink cheeks", "粉色脸颊"],
    ["pink blush", "粉色腮红"],
    ["orbiting Earth at night", "在夜晚环绕地球运行"],
    ["solar panels", "太阳能板"],
    ["container ship", "集装箱货轮"],
    ["satellite", "卫星"],
    ["crane", "起重机"],
    ["building", "建筑"],
    ["port", "港口"],
    ["high detail", "高细节"],
    ["highly detailed", "高细节"],
    ["ultra detailed", "超高细节"],
    ["best quality", "高质量"],
    ["masterpiece", "杰作级质感"],
    ["precise forms", "精准造型"],
    ["soft lighting", "柔和打光"],
    ["dramatic lighting", "戏剧化光照"],
    ["dynamic pose", "动态姿态"],
    ["metallic sheen", "金属光泽"],
    ["mechanical components", "机械部件"],
    ["deep space background", "深空背景"]
  ];
}

function getLocalizedWordReplacements() {
  return [
    ["illustration", "插画"],
    ["cyberpunk", "赛博朋克"],
    ["sci-fi", "科幻"],
    ["futuristic", "未来感"],
    ["high-tech", "高科技"],
    ["design", "设计"],
    ["yellow", "黄色"],
    ["black", "黑色"],
    ["mask", "面罩"],
    ["armor", "装甲"],
    ["armored", "装甲式"],
    ["suit", "战衣"],
    ["bodysuit", "紧身战衣"],
    ["torso", "躯干"],
    ["upper body", "上半身"],
    ["lighting", "光照"],
    ["highlighting", "突出"],
    ["highlight", "突出"],
    ["form", "轮廓"],
    ["attire", "服装"],
    ["pose", "姿态"],
    ["dynamic", "动态"],
    ["strength", "力量感"],
    ["agility", "敏捷感"],
    ["face", "面部"],
    ["body", "身体"],
    ["components", "部件"],
    ["textures", "纹理"],
    ["texture", "纹理"],
    ["patterns", "纹样"],
    ["smooth", "平滑"],
    ["glossy", "光泽"],
    ["dramatic", "戏剧化"],
    ["soft", "柔和"],
    ["clean", "干净"],
    ["cyborg", "义体人"],
    ["female", "女性"],
    ["character", "角色"],
    ["outfit", "服装"],
    ["includes", "包含"],
    ["mood", "氛围"],
    ["color scheme", "配色"],
    ["focus", "聚焦"],
    ["realistic", "写实"],
    ["vehicle", "交通工具"],
    ["portrait", "人像"],
    ["background", "背景"],
    ["cool tones", "冷色调"],
    ["wearing", "穿着"],
    ["exposed", "外露"],
    ["sleek", "流线型"],
    ["blurry", "模糊"],
    ["blurred", "模糊"],
    ["low quality", "低质量"],
    ["bad anatomy", "结构错误"],
    ["extra fingers", "多余手指"],
    ["distorted face", "脸部畸形"],
    ["warped geometry", "几何结构扭曲"],
    ["broken perspective", "透视错误"],
    ["messy composition", "构图杂乱"],
    ["low detail", "细节不足"]
  ];
}

function applyLocalizedReplacements(text, replacements) {
  let output = String(text || "");
  for (const [from, to] of replacements.sort((a, b) => b[0].length - a[0].length)) {
    output = output.replace(new RegExp(escapeRegExp(from), "gi"), to);
  }
  return output;
}

function applyLocalizedWordReplacements(text, replacements) {
  let output = String(text || "");
  for (const [from, to] of replacements.sort((a, b) => b[0].length - a[0].length)) {
    output = output.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi"), to);
  }
  return output;
}

function stripResidualEnglish(text) {
  const whitelist = new Set(["CGI", "3D", "SDXL", "Flux", "Midjourney", "MJ"]);

  return String(text || "").replace(/\b[a-zA-Z][a-zA-Z'-]*\b/g, (word) => {
    const normalized = word.replace(/[^a-zA-Z]/g, "");
    if (!normalized) {
      return "";
    }
    for (const allowed of whitelist) {
      if (normalized.toLowerCase() === allowed.toLowerCase()) {
        return allowed;
      }
    }
    return "";
  });
}

function pickCleanerLocalizedBundle(primaryBundle, fallbackBundle) {
  return englishContaminationScore(primaryBundle) <= englishContaminationScore(fallbackBundle)
    ? primaryBundle
    : fallbackBundle;
}

function englishContaminationScore(bundle) {
  const texts = [
    bundle.localizedPromptModes?.concise,
    bundle.localizedPromptModes?.detailed,
    bundle.localizedPromptModes?.pro,
    bundle.localizedNegativePrompt
  ]
    .map((item) => String(item || ""))
    .join(" ");

  const englishWords = texts.match(/\b[a-zA-Z]{2,}\b/g) || [];
  return englishWords.length;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeIncomingPromptModes(promptModes) {
  return {
    concise: String(promptModes?.concise || "").trim(),
    detailed: String(promptModes?.detailed || promptModes?.concise || "").trim(),
    pro: String(promptModes?.pro || promptModes?.detailed || promptModes?.concise || "").trim()
  };
}

function normalizeIncomingPromptVariants(promptVariants, promptModes) {
  if (promptVariants?.concise || promptVariants?.detailed || promptVariants?.pro) {
    return {
      concise: normalizeIncomingVariantRow(promptVariants.concise, promptModes.concise),
      detailed: normalizeIncomingVariantRow(promptVariants.detailed, promptModes.detailed || promptModes.concise),
      pro: normalizeIncomingVariantRow(promptVariants.pro, promptModes.pro || promptModes.detailed || promptModes.concise)
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

function fallbackTranslatePromptText(text) {
  const source = String(text || "").trim();
  if (!source) {
    return "";
  }

  const sceneTemplate = buildLocalizedSceneTemplateFromEnglish(source);
  if (sceneTemplate) {
    return sceneTemplate;
  }

  const protectedFlags = [];
  let output = source.replace(/--[a-zA-Z0-9:-]+(?:\s+[a-zA-Z0-9:./-]+)?/g, (match) => {
    const token = `__FLAG_${protectedFlags.length}__`;
    protectedFlags.push(match);
    return token;
  });

  output = applyLocalizedReplacements(output, getLocalizedPhraseReplacements());
  output = applyLocalizedWordReplacements(output, getLocalizedWordReplacements());
  output = output.replace(/__FLAG_(\d+)__/g, (_, index) => protectedFlags[Number(index)] || "");

  return normalizeLocalizedPromptText(output);
}

function normalizeLocalizedPromptText(text) {
  let output = String(text || "").trim();
  if (!output) {
    return "";
  }

  const protectedFlags = [];
  output = output.replace(/--[a-zA-Z0-9:-]+(?:\s+[a-zA-Z0-9:./-]+)?/g, (match) => {
    const token = `__FLAG_${protectedFlags.length}__`;
    protectedFlags.push(match);
    return token;
  });

  output = applyLocalizedReplacements(output, getLocalizedPhraseReplacements());
  output = applyLocalizedWordReplacements(output, getLocalizedWordReplacements());

  output = output
    .replace(/['"`]/g, " ")
    .replace(/\b(a|an|the)\b/gi, " ")
    .replace(/\b(her|his|their|she|he|they|it)\b/gi, " ")
    .replace(/\b(is|are|was|were|be|being|been|having|with|and|of|from|to|that|on|in|at|by|for|into|over|under|below|above)\b/gi, "，")
    .replace(/[,:;]+/g, "，")
    .replace(/，\s*，+/g, "，")
    .replace(/\s*，\s*/g, "，")
    .replace(/\s+/g, " ")
    .trim();

  output = output.replace(/__FLAG_(\d+)__/g, (_, index) => protectedFlags[Number(index)] || "");
  output = stripResidualEnglish(output);

  return output
    .replace(/，，+/g, "，")
    .replace(/，(3D|CGI)/g, "，$1")
    .replace(/(^|，)\s*(高科技|未来感|流线型)\s*(，\s*\1)?/g, "$1$2，")
    .replace(/(，\s*){2,}/g, "，")
    .replace(/^，+|，+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getLocalizedPhraseReplacements() {
  return [
    ["cloud computing concept", "云计算概念展示"],
    ["data visualization elements", "数据可视化元素"],
    ["dashboard interface display", "数据看板界面展示"],
    ["minimal product showcase", "极简产品展示风格"],
    ["minimal product showcase environment", "极简科技产品展示环境"],
    ["clean layered tech platform", "层叠式科技平台底座"],
    ["blue and white palette", "蓝白配色"],
    ["cool-toned palette", "冷色调配色"],
    ["soft ambient lighting", "柔和环境光"],
    ["soft global illumination", "柔和全局光照"],
    ["clean CGI render", "干净的 CGI 渲染"],
    ["clean product-style presentation", "产品展示式构图"],
    ["centered object composition", "主体居中构图"],
    ["clean industrial composition", "干净的工业场景构图"],
    ["clean architectural composition", "干净的建筑构图"],
    ["balanced interior composition", "平衡的室内构图"],
    ["wide scenic composition", "宽幅风景构图"],
    ["clean poster composition", "干净的海报构图"],
    ["clean composition", "干净构图"],
    ["clean studio background", "干净的纯色背景"],
    ["clean geometric forms", "干净的几何造型"],
    ["soft clean surfaces", "干净平滑的表面"],
    ["smooth clean surfaces", "平滑干净的表面"],
    ["graphic design composition", "平面设计式构图"],
    ["architectural visualization", "建筑可视化效果"],
    ["industrial scene", "工业场景"],
    ["realistic CGI", "写实 CGI"],
    ["realistic rendering", "写实渲染"],
    ["stylized 3D render", "风格化 3D 渲染"],
    ["doll-like 3D render", "人偶感 3D 渲染"],
    ["anime-inspired 3D render", "动漫感 3D 渲染"],
    ["3D rendered", "3D 渲染"],
    ["3D rendering", "3D 渲染"],
    ["3D render", "3D 渲染"],
    ["CGI render", "CGI 渲染"],
    ["satellite with solar panels orbiting Earth at night", "带有太阳能板的卫星在夜晚环绕地球"],
    ["orbiting Earth at night", "在夜晚环绕地球"],
    ["deep space background", "深空背景"],
    ["glowing planetary curvature below", "下方可见发光的地球弧面"],
    ["cloud icon", "云朵图标"],
    ["bar chart", "柱状图"],
    ["pie chart", "饼图"],
    ["dashboard", "数据看板"],
    ["analytics dashboard", "分析看板"],
    ["data visualization", "数据可视化"],
    ["tablet screen", "平板屏幕"],
    ["screen", "屏幕"],
    ["interface", "界面"],
    ["platform", "平台底座"],
    ["high detail", "高细节"],
    ["highly detailed", "高细节"],
    ["ultra detailed", "超高细节"],
    ["best quality", "高质量"],
    ["crisp render quality", "清晰渲染质感"],
    ["precise forms", "精准造型"],
    ["rich material detail", "丰富材质细节"],
    ["polished stylization", "精修风格化处理"],
    ["refined lighting", "精致光照"],
    ["cinematic composition", "电影感构图"],
    ["soft lighting", "柔和打光"],
    ["dramatic lighting", "戏剧化光照"],
    ["cyberpunk aesthetic", "赛博朋克美学"],
    ["sci-fi character design", "科幻角色设计"],
    ["mecha-inspired armor design", "机甲感装甲设计"],
    ["cybernetic body details", "义体机械细节"],
    ["cybernetic enhancements", "义体强化细节"],
    ["female cyborg", "女性义体人"],
    ["mechanical arm", "机械手臂"],
    ["robotic armor", "机械装甲"],
    ["futuristic mask", "未来感面罩"],
    ["high-tech suit", "高科技战衣"],
    ["white hoodie", "白色连帽衫"],
    ["white hair", "白发"],
    ["blue eyes", "蓝眼睛"],
    ["pink cheeks", "粉色脸颊"],
    ["pink blush", "粉色腮红"],
    ["light blue background", "浅蓝色背景"],
    ["soft light blue background", "柔和浅蓝背景"]
  ];
}

function getLocalizedWordReplacements() {
  return [
    ["cyberpunk", "赛博朋克"],
    ["sci-fi", "科幻"],
    ["futuristic", "未来感"],
    ["high-tech", "高科技"],
    ["cloud", "云朵"],
    ["dashboard", "看板"],
    ["analytics", "分析"],
    ["data", "数据"],
    ["visualization", "可视化"],
    ["chart", "图表"],
    ["graph", "图表"],
    ["tablet", "平板"],
    ["screen", "屏幕"],
    ["interface", "界面"],
    ["platform", "平台"],
    ["design", "设计"],
    ["yellow", "黄色"],
    ["black", "黑色"],
    ["mask", "面罩"],
    ["armor", "装甲"],
    ["armored", "装甲式"],
    ["suit", "战衣"],
    ["bodysuit", "紧身战衣"],
    ["wearing", "穿着"],
    ["exposed", "外露"],
    ["sleek", "流线型"],
    ["torso", "躯干"],
    ["upper body", "上半身"],
    ["lighting", "光照"],
    ["highlighting", "突出"],
    ["highlight", "突出"],
    ["form", "轮廓"],
    ["attire", "服装"],
    ["outfit", "服装"],
    ["includes", "包含"],
    ["mood", "氛围"],
    ["pose", "姿态"],
    ["dynamic", "动态"],
    ["smooth", "平滑"],
    ["glossy", "光泽"],
    ["dramatic", "戏剧化"],
    ["soft", "柔和"],
    ["clean", "干净"],
    ["realistic", "写实"],
    ["portrait", "人像"],
    ["background", "背景"],
    ["cool tones", "冷色调"],
    ["character", "角色"],
    ["female", "女性"],
    ["cyborg", "义体人"],
    ["satellite", "卫星"],
    ["solar panels", "太阳能板"],
    ["container ship", "集装箱货轮"],
    ["port", "港口"],
    ["crane", "起重机"],
    ["building", "建筑"],
    ["blurry", "模糊"],
    ["blurred", "模糊"],
    ["low quality", "低质量"],
    ["bad anatomy", "结构错误"],
    ["extra fingers", "多余手指"],
    ["distorted face", "脸部畸形"],
    ["warped geometry", "几何结构扭曲"],
    ["broken perspective", "透视错误"],
    ["messy composition", "构图杂乱"],
    ["low detail", "细节不足"]
  ];
}

function buildLocalizedSceneTemplateFromEnglish(text) {
  const lower = String(text || "").toLowerCase();

  if (
    /\b(cloud|dashboard|analytics|data visualization|bar chart|pie chart|chart|graph|tablet|screen|interface|platform)\b/.test(
      lower
    )
  ) {
    const parts = [];
    if (/\b(blue and white|cool tones|cool-toned)\b/.test(lower)) {
      parts.push("蓝白配色");
    }
    parts.push("未来科技 3D 场景");
    if (/\bcloud\b/.test(lower)) {
      parts.push("中心为云计算图标");
    }
    if (/\b(bar chart|chart|graph)\b/.test(lower)) {
      parts.push("带有柱状图与图表面板");
    }
    if (/\bpie chart\b/.test(lower)) {
      parts.push("配有饼图组件");
    }
    if (/\b(tablet|screen|dashboard|interface)\b/.test(lower)) {
      parts.push("包含数据看板屏幕");
    }
    parts.push("层叠式科技平台底座");
    parts.push("半透明与平滑材质");
    parts.push("柔和冷色环境光");
    parts.push("极简产品展示风格");
    parts.push("主体居中构图");
    parts.push("干净明亮的高科技环境");
    parts.push("高细节");
    return dedupeStrings(parts).join("，");
  }

  return "";
}

const fileInput = document.getElementById("fileInput");
const uploadBox = document.getElementById("uploadBox");
const uploadEmpty = document.getElementById("uploadEmpty");
const uploadPreview = document.getElementById("uploadPreview");
const previewImage = document.getElementById("previewImage");
const generateButton = document.getElementById("generateButton");
const generateButtonText = document.getElementById("generateButtonText");
const statusMessage = document.getElementById("statusMessage");
const resultPanel = document.getElementById("resultPanel");
const promptOutput = document.getElementById("promptOutput");
const negativeOutput = document.getElementById("negativeOutput");
const copyPromptButton = document.getElementById("copyPromptButton");
const copyNegativeButton = document.getElementById("copyNegativeButton");
const langEnButton = document.getElementById("langEnButton");
const langZhButton = document.getElementById("langZhButton");

const sourceParam = new URLSearchParams(window.location.search).get("source") || "toolbar";
const MAX_UPLOAD_EDGE = 2048;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MIN_WINDOW_HEIGHT = 360;
const MAX_WINDOW_HEIGHT = 980;
const DEFAULT_MODE_KEY = "detailed";

let currentImageState = null;
let currentResult = null;
let currentVariantKey = "general";
let currentModeKey = DEFAULT_MODE_KEY;
let currentLanguage = "en";
let previewObjectUrl = null;
let isGenerating = false;
let resizeTimer = null;
let resizeObserver = null;

init();

async function init() {
  bindEvents();
  renderModeButtons();
  renderVariantButtons();
  renderLanguageToggle();
  setIdleUploadState();
  setupResizeTracking();

  if (sourceParam === "context-menu") {
    await loadContextMenuImageOnce();
  } else {
    await chrome.storage.local.remove(["lastImageSource"]);
  }

  scheduleWindowResize();
}

function bindEvents() {
  uploadBox.addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });
  fileInput.addEventListener("change", onFileSelected);
  generateButton.addEventListener("click", onGeneratePrompt);
  langEnButton.addEventListener("click", () => onSelectLanguage("en"));
  langZhButton.addEventListener("click", () => onSelectLanguage("zh"));
  copyPromptButton.addEventListener("click", () => onCopyText(getCurrentPromptText()));
  copyNegativeButton.addEventListener("click", () => onCopyText(getCurrentNegativeText()));

  uploadBox.addEventListener("dragenter", onDragEnter);
  uploadBox.addEventListener("dragover", onDragEnter);
  uploadBox.addEventListener("dragleave", onDragLeave);
  uploadBox.addEventListener("drop", onDropFile);

  resultPanel.addEventListener("click", async (event) => {
    const modeButton = event.target.closest("[data-mode]");
    if (modeButton) {
      const previousModeKey = currentModeKey;
      currentModeKey = modeButton.dataset.mode;
      renderModeButtons();
      if (currentLanguage === "zh" && !(await ensureLocalizedCurrentPrompt())) {
        currentModeKey = previousModeKey;
        renderModeButtons();
        return;
      }
      renderResult(currentResult);
      return;
    }

    const variantButton = event.target.closest("[data-variant]");
    if (variantButton) {
      const previousVariantKey = currentVariantKey;
      currentVariantKey = variantButton.dataset.variant;
      renderVariantButtons();
      if (currentLanguage === "zh" && !(await ensureLocalizedCurrentPrompt())) {
        currentVariantKey = previousVariantKey;
        renderVariantButtons();
        return;
      }
      renderResult(currentResult);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "PROMPTLENS_UPDATE_IMAGE") {
      return;
    }

    if (message.reset) {
      setIdleUploadState();
      return;
    }

    if (message.imageSource?.imageUrl) {
      setCurrentImage({
        kind: "url",
        imageUrl: message.imageSource.imageUrl,
        pageTitle: message.imageSource.pageTitle || "",
        pageUrl: message.imageSource.pageUrl || ""
      });
    }
  });
}

async function loadContextMenuImageOnce() {
  const { lastImageSource } = await chrome.storage.local.get(["lastImageSource"]);
  await chrome.storage.local.remove(["lastImageSource"]);

  if (!lastImageSource?.imageUrl) {
    return;
  }

  setCurrentImage({
    kind: "url",
    imageUrl: lastImageSource.imageUrl,
    pageTitle: lastImageSource.pageTitle || "",
    pageUrl: lastImageSource.pageUrl || ""
  });
}

function setupResizeTracking() {
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(() => {
      scheduleWindowResize();
    });
    resizeObserver.observe(document.body);
  }

  window.addEventListener("load", scheduleWindowResize);
}

function scheduleWindowResize() {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(resizeWindowToContent, 60);
}

async function resizeWindowToContent() {
  if (!chrome.windows?.getCurrent || !chrome.windows?.update) {
    return;
  }

  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (!currentWindow?.id) {
      return;
    }

    const chromeFrameHeight = Math.max(0, window.outerHeight - window.innerHeight);
    const desiredContentHeight = Math.ceil(document.documentElement.scrollHeight);
    const desiredHeight = clamp(desiredContentHeight + chromeFrameHeight, MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT);

    if (Math.abs((currentWindow.height || 0) - desiredHeight) > 6) {
      await chrome.windows.update(currentWindow.id, { height: desiredHeight });
    }
  } catch (_error) {
    // Ignore window resize failures inside unsupported hosts.
  }
}

function onDragEnter(event) {
  event.preventDefault();
  uploadBox.classList.add("is-dragover");
}

function onDragLeave(event) {
  event.preventDefault();
  if (event.target === uploadBox) {
    uploadBox.classList.remove("is-dragover");
  }
}

async function onDropFile(event) {
  event.preventDefault();
  uploadBox.classList.remove("is-dragover");
  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }

  await useLocalFile(file);
}

async function onFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  await useLocalFile(file);
}

async function useLocalFile(file) {
  clearPreviewObjectUrl();
  previewObjectUrl = URL.createObjectURL(file);
  setCurrentImage({
    kind: "file",
    file,
    fileName: file.name,
    previewUrl: previewObjectUrl
  });
}

function setCurrentImage(nextState) {
  currentImageState = nextState;
  currentResult = null;
  currentModeKey = DEFAULT_MODE_KEY;
  currentVariantKey = "general";
  currentLanguage = "en";
  renderLanguageToggle();

  if (!nextState) {
    setIdleUploadState();
    return;
  }

  uploadEmpty.classList.add("is-hidden");
  uploadPreview.classList.remove("is-hidden");
  previewImage.src = nextState.previewUrl || nextState.imageUrl || "";
  previewImage.alt = nextState.fileName || nextState.pageTitle || "图片预览";

  generateButton.disabled = false;
  hideResults();
  clearStatus();

  if (nextState.kind === "file") {
    setStatus(`已选择图片：${nextState.fileName}`, "success");
  } else {
    setStatus("已加载右键选中的网页图片", "success");
  }

  scheduleWindowResize();
}

function setIdleUploadState() {
  currentImageState = null;
  currentResult = null;
  currentModeKey = DEFAULT_MODE_KEY;
  currentVariantKey = "general";
  currentLanguage = "en";
  renderLanguageToggle();
  generateButton.disabled = true;
  stopGenerateLoading();
  uploadEmpty.classList.remove("is-hidden");
  uploadPreview.classList.add("is-hidden");
  previewImage.removeAttribute("src");
  previewImage.removeAttribute("alt");
  hideResults();
  clearStatus();
  clearPreviewObjectUrl();
  scheduleWindowResize();
}

async function onGeneratePrompt() {
  if (!currentImageState || isGenerating) {
    return;
  }

  const { backendBaseUrl, appToken } = await chrome.storage.sync.get(["backendBaseUrl", "appToken"]);
  if (!backendBaseUrl) {
    setStatus("请先在设置页配置后端地址。", "error");
    return;
  }

  isGenerating = true;
  startGenerateLoading();
  hideResults();
  setStatus("正在生成提示词，请稍候…", "success");

  try {
    if (currentImageState.kind === "file") {
      const metadataResult = await tryParsePngPromptMetadata(currentImageState.file);
      if (metadataResult) {
        currentResult = metadataResult;
        currentLanguage = "en";
        renderLanguageToggle();
        showResults();
        renderResult(currentResult);
        setStatus("已从 PNG 元数据中提取提示词。", "success");
        return;
      }
    }

    const payload = await buildPayloadFromCurrentImage(currentImageState);
    const response = await fetch(`${backendBaseUrl.replace(/\/$/, "")}/api/reverse-prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(appToken ? { "X-App-Token": appToken } : {})
      },
      body: JSON.stringify(payload)
    });

    const result = await readJsonResponse(response, "请求失败");
    if (!response.ok) {
      throw new Error(result.error || "请求失败");
    }

    currentResult = result;
    currentResult.localizedPromptModes = null;
    currentResult.localizedPromptVariants = null;
    currentResult.localizedNegativePrompt = "";
    currentModeKey = DEFAULT_MODE_KEY;
    currentVariantKey = "general";
    currentLanguage = "en";
    renderLanguageToggle();
    showResults();
    renderResult(result);
    setStatus("提示词生成完成。", "success");
  } catch (error) {
    console.error(error);
    currentResult = null;
    hideResults();
    setStatus(error.message || "生成失败", "error");
  } finally {
    isGenerating = false;
    stopGenerateLoading();
  }
}

async function onSelectLanguage(nextLanguage) {
  if (nextLanguage === currentLanguage) {
    return;
  }

  if (nextLanguage === "zh") {
    const hasLocalizedPrompt = await ensureLocalizedCurrentPrompt();
    if (!hasLocalizedPrompt) {
      return;
    }
  }

  currentLanguage = nextLanguage;
  renderLanguageToggle();
  renderResult(currentResult);
}

function renderLanguageToggle() {
  if (!langEnButton || !langZhButton) {
    return;
  }

  langEnButton.classList.toggle("is-active", currentLanguage === "en");
  langZhButton.classList.toggle("is-active", currentLanguage === "zh");
}

function startGenerateLoading() {
  generateButton.disabled = true;
  generateButton.classList.add("is-loading");
  generateButtonText.textContent = "正在生成...";
}

function stopGenerateLoading() {
  generateButton.classList.remove("is-loading");
  generateButtonText.textContent = "生成提示词";
  generateButton.disabled = !currentImageState;
}

async function buildPayloadFromCurrentImage(imageState) {
  if (imageState.kind === "file") {
    const dataUrl = await prepareImageDataUrl(imageState.file);
    return {
      imageBase64: dataUrl,
      fileName: imageState.fileName || imageState.file?.name || ""
    };
  }

  return buildPayloadFromImageUrl(imageState.imageUrl);
}

async function buildPayloadFromImageUrl(imageUrl) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Image fetch failed: ${response.status}`);
    }

    const blob = await response.blob();
    const dataUrl = await prepareImageDataUrl(blob);
    return { imageBase64: dataUrl };
  } catch (_error) {
    return { imageUrl };
  }
}

function renderResult(result) {
  if (!result) {
    return;
  }

  renderModeButtons();
  renderVariantButtons();
  renderLanguageToggle();
  promptOutput.textContent = getCurrentPromptText() || "暂无提示词";
  promptOutput.className = "text-surface text-surface--large";
  negativeOutput.textContent = getCurrentNegativeText() || "暂无负面提示词";
  negativeOutput.className = "text-surface text-surface--small";
  scheduleWindowResize();
}

function getCurrentPromptText() {
  if (!currentResult) {
    return "";
  }

  if (currentLanguage === "zh") {
    const localizedPrompt = getLocalizedCurrentPromptText();
    if (localizedPrompt) {
      return localizedPrompt;
    }
  }

  return getEnglishCurrentPromptText();
}

function getCurrentNegativeText() {
  if (!currentResult) {
    return "";
  }

  if (currentLanguage === "zh") {
    return currentResult.localizedNegativePrompt || currentResult.negativePrompt || "";
  }

  return currentResult.negativePrompt || "";
}

function getEnglishCurrentPromptText() {
  if (!currentResult) {
    return "";
  }

  const variants = normalizeVariants(currentResult.promptVariants);
  const modes = normalizeModes(currentResult.promptModes, currentResult.prompt);
  const activeVariants = variants[currentModeKey] || variants.detailed || variants.pro || {};

  return (
    activeVariants[currentVariantKey] ||
    activeVariants.general ||
    modes[currentModeKey] ||
    modes.detailed ||
    currentResult.prompt ||
    ""
  );
}

function getLocalizedCurrentPromptText(result = currentResult) {
  if (!result) {
    return "";
  }

  const variants = normalizeVariants(result.localizedPromptVariants || {});
  const activeVariants = variants[currentModeKey] || {};

  return activeVariants[currentVariantKey] || "";
}

async function ensureLocalizedCurrentPrompt() {
  if (!currentResult) {
    return false;
  }

  if (hasUsableLocalizedCurrentPrompt(currentResult)) {
    return true;
  }

  const promptText = getEnglishCurrentPromptText();
  if (!promptText) {
    setStatus("当前没有可翻译的提示词。", "error");
    return false;
  }

  const { backendBaseUrl, appToken } = await chrome.storage.sync.get(["backendBaseUrl", "appToken"]);
  if (!backendBaseUrl) {
    setStatus("请先在设置页配置后端地址。", "error");
    return false;
  }

  setStatus("正在切换为中文提示词…", "success");

  try {
    const response = await fetch(`${backendBaseUrl.replace(/\/$/, "")}/api/translate-prompts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(appToken ? { "X-App-Token": appToken } : {})
      },
      body: JSON.stringify({
        promptText,
        negativePrompt: currentResult.negativePrompt || "",
        modeKey: currentModeKey,
        variantKey: currentVariantKey
      })
    });

    const translated = await readJsonResponse(response, "中文翻译失败");
    if (!response.ok) {
      throw new Error(translated.error || "中文翻译失败");
    }

    setLocalizedCurrentPrompt(
      translated.localizedPrompt || translated.prompt || "",
      translated.localizedNegativePrompt || translated.negativePrompt || ""
    );
    if (!hasUsableLocalizedCurrentPrompt(currentResult)) {
      throw new Error("中文翻译结果不可用，请稍后重试");
    }

    clearStatus();
    return true;
  } catch (error) {
    console.error(error);
    setStatus(error.message || "中文翻译失败", "error");
    return false;
  }
}

function setLocalizedCurrentPrompt(localizedPrompt, localizedNegativePrompt) {
  currentResult.localizedPromptModes = currentResult.localizedPromptModes || {};
  currentResult.localizedPromptVariants = currentResult.localizedPromptVariants || {};
  currentResult.localizedPromptVariants[currentModeKey] =
    currentResult.localizedPromptVariants[currentModeKey] || {};

  currentResult.localizedPromptModes[currentModeKey] = String(localizedPrompt || "").trim();
  currentResult.localizedPromptVariants[currentModeKey][currentVariantKey] = String(localizedPrompt || "").trim();
  currentResult.localizedNegativePrompt = String(localizedNegativePrompt || "").trim();
}

async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    const cleaned = normalizeHttpErrorMessage(text, fallbackMessage);
    if (!response.ok) {
      throw new Error(cleaned);
    }

    throw new Error(fallbackMessage);
  }
}

function normalizeHttpErrorMessage(text, fallbackMessage) {
  const value = String(text || "").trim();
  if (!value) {
    return fallbackMessage;
  }

  if (/^Internal Server Error/i.test(value)) {
    return "服务端临时错误，请稍后重试";
  }

  return value.slice(0, 180);
}

function hasUsableLocalizedCurrentPrompt(result) {
  const localizedPrompt = getLocalizedCurrentPromptText(result);
  const localizedNegative = result.localizedNegativePrompt;
  const sourceNegative = String(result.negativePrompt || "").trim();
  return Boolean(
    looksLikeCleanChinese(localizedPrompt) &&
      (!sourceNegative || containsChineseText(sourceNegative) || looksLikeCleanChinese(localizedNegative))
  );
}

function containsChineseText(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

function looksLikeCleanChinese(value) {
  const text = String(value || "").trim();
  if (!text || !containsChineseText(text)) {
    return false;
  }

  const englishWords = stripGenerationFlags(text).match(/\b[a-zA-Z]{2,}\b/g) || [];
  return englishWords.length <= 1;
}

function stripGenerationFlags(value) {
  return String(value || "").replace(/--[a-zA-Z][a-zA-Z0-9-]*(?:[=\s]+[^\s,，。；;]+)?/g, " ");
}

function normalizeVariants(result) {
  if (result?.detailed || result?.pro) {
    return {
      detailed: result.detailed || {},
      pro: result.pro || {}
    };
  }

  const fallback = {
    general: result?.general || "",
    midjourney: result?.midjourney || "",
    sdxl: result?.sdxl || "",
    flux: result?.flux || ""
  };

  return { detailed: fallback, pro: fallback };
}

function normalizeModes(result, fallbackPrompt = "") {
  return {
    detailed: result?.detailed || fallbackPrompt || "",
    pro: result?.pro || result?.detailed || fallbackPrompt || ""
  };
}

function renderModeButtons() {
  resultPanel.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === currentModeKey);
  });
}

function renderVariantButtons() {
  resultPanel.querySelectorAll("[data-variant]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.variant === currentVariantKey);
  });
}

function showResults() {
  resultPanel.classList.remove("is-hidden");
  scheduleWindowResize();
}

function hideResults() {
  resultPanel.classList.add("is-hidden");
  scheduleWindowResize();
}

async function onCopyText(text) {
  const value = String(text || "").trim();
  if (!value) {
    return;
  }

  await navigator.clipboard.writeText(value);
  setStatus("已复制到剪贴板。", "success");
}

function setStatus(message, kind = "success") {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${kind === "error" ? "is-error" : "is-success"}`;
  scheduleWindowResize();
}

function clearStatus() {
  statusMessage.textContent = "";
  statusMessage.className = "status-message is-hidden";
  scheduleWindowResize();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function prepareImageDataUrl(fileOrBlob) {
  if (!needsResize(fileOrBlob)) {
    return fileToDataUrl(fileOrBlob);
  }

  return resizeImageToJpeg(fileOrBlob);
}

function needsResize(fileOrBlob) {
  return (fileOrBlob.size || 0) > MAX_UPLOAD_BYTES;
}

async function resizeImageToJpeg(fileOrBlob) {
  const bitmap = await createImageBitmap(fileOrBlob);
  const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.92);
  });

  if (!blob) {
    throw new Error("图片压缩失败");
  }

  return blobToDataUrl(blob);
}

async function tryParsePngPromptMetadata(file) {
  if (!file.type.includes("png")) {
    return null;
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) {
    return null;
  }

  let offset = 8;
  const textEntries = [];

  while (offset + 8 < bytes.length) {
    const length = readUint32(bytes, offset);
    const chunkType = readAscii(bytes.slice(offset + 4, offset + 8));
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + length;

    if (chunkDataEnd > bytes.length) {
      break;
    }

    if (chunkType === "tEXt") {
      const raw = readAscii(bytes.slice(chunkDataStart, chunkDataEnd));
      const separatorIndex = raw.indexOf("\u0000");
      if (separatorIndex > -1) {
        textEntries.push({
          key: raw.slice(0, separatorIndex),
          value: raw.slice(separatorIndex + 1)
        });
      }
    }

    offset = chunkDataEnd + 4;
  }

  const parametersEntry = textEntries.find((entry) => /parameters/i.test(entry.key));
  if (!parametersEntry) {
    return null;
  }

  const parsed = parseStableDiffusionParameters(parametersEntry.value);
  return {
    source: "client-metadata",
    confidence: 1,
    prompt: parsed.prompt,
    negativePrompt: parsed.negativePrompt,
    localizedNegativePrompt: "",
    promptModes: {
      detailed: parsed.prompt,
      pro: parsed.prompt
    },
    localizedPromptModes: null,
    promptVariants: {
      detailed: { general: parsed.prompt, midjourney: parsed.prompt, sdxl: parsed.prompt, flux: parsed.prompt },
      pro: { general: parsed.prompt, midjourney: parsed.prompt, sdxl: parsed.prompt, flux: parsed.prompt }
    },
    localizedPromptVariants: null
  };
}

function parseStableDiffusionParameters(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const negativeIndex = lines.findIndex((line) => line.startsWith("Negative prompt:"));
  const prompt = negativeIndex === -1 ? lines[0] || "" : lines.slice(0, negativeIndex).join(", ");
  const negativePrompt =
    negativeIndex === -1 ? "" : lines[negativeIndex].replace(/^Negative prompt:\s*/i, "");

  return { prompt, negativePrompt };
}

function readUint32(bytes, offset) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function readAscii(bytes) {
  return Array.from(bytes)
    .map((byte) => String.fromCharCode(byte))
    .join("");
}

function clearPreviewObjectUrl() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

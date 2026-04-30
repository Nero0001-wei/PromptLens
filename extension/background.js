const MENU_ID = "reverse-prompt-image";
const INSPECTOR_WINDOW_ID_KEY = "inspectorWindowId";
const POPUP_WIDTH = 392;
const INITIAL_POPUP_HEIGHT = 540;
const RIGHT_EDGE_OFFSET = 20;
const TOP_EDGE_OFFSET = 84;
const CAPTURE_MAX_EDGE = 1800;
const CAPTURE_JPEG_QUALITY = 0.92;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "PromptLens：反推这张图片的提示词",
      contexts: ["image"]
    });
  });
});

chrome.action.onClicked.addListener(async () => {
  await chrome.storage.local.remove(["lastImageSource"]);
  await openInspectorPopup("toolbar", { reset: true });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) {
    return;
  }

  const imageSource = {
    kind: "url",
    imageUrl: info.srcUrl,
    pageUrl: tab?.url || "",
    pageTitle: tab?.title || "",
    createdAt: new Date().toISOString()
  };

  const capturedImage = await captureSelectedImageFromTab(tab, info.srcUrl);
  if (capturedImage) {
    imageSource.kind = "capture";
    imageSource.imageBase64 = capturedImage;
    imageSource.previewUrl = capturedImage;
  }

  await chrome.storage.local.set({
    lastImageSource: imageSource
  });

  await openInspectorPopup("context-menu", { imageSource });
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { [INSPECTOR_WINDOW_ID_KEY]: inspectorWindowId } = await chrome.storage.local.get([
    INSPECTOR_WINDOW_ID_KEY
  ]);

  if (windowId === inspectorWindowId) {
    await chrome.storage.local.remove([INSPECTOR_WINDOW_ID_KEY]);
  }
});

async function openInspectorPopup(source, payload = {}) {
  const url = chrome.runtime.getURL(`inspector.html?source=${encodeURIComponent(source)}`);
  const bounds = await getPopupBounds();
  const existing = await getExistingInspectorWindow();

  if (existing?.id) {
    await chrome.windows.update(existing.id, {
      focused: true,
      left: bounds.left,
      top: bounds.top
    });

    const [inspectorTab] = await chrome.tabs.query({ windowId: existing.id });
    if (inspectorTab?.id) {
      await ensureInspectorTab(inspectorTab.id, url);
      await sendInspectorMessage(inspectorTab.id, source, payload);
      return;
    }
  }

  const createdWindow = await chrome.windows.create({
    url,
    type: "popup",
    width: POPUP_WIDTH,
    height: INITIAL_POPUP_HEIGHT,
    left: bounds.left,
    top: bounds.top,
    focused: true
  });

  if (createdWindow?.id) {
    await chrome.storage.local.set({ [INSPECTOR_WINDOW_ID_KEY]: createdWindow.id });
  }
}

async function getExistingInspectorWindow() {
  const { [INSPECTOR_WINDOW_ID_KEY]: inspectorWindowId } = await chrome.storage.local.get([
    INSPECTOR_WINDOW_ID_KEY
  ]);

  if (!inspectorWindowId) {
    return null;
  }

  try {
    return await chrome.windows.get(inspectorWindowId);
  } catch (_error) {
    await chrome.storage.local.remove([INSPECTOR_WINDOW_ID_KEY]);
    return null;
  }
}

async function ensureInspectorTab(tabId, fallbackUrl) {
  const tab = await chrome.tabs.get(tabId);
  const inspectorUrl = chrome.runtime.getURL("inspector.html");

  if (!tab.url?.startsWith(inspectorUrl)) {
    await chrome.tabs.update(tabId, { url: fallbackUrl });
    await waitForTabLoaded(tabId);
  }
}

async function sendInspectorMessage(tabId, source, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "PROMPTLENS_UPDATE_IMAGE",
      source,
      reset: Boolean(payload.reset),
      imageSource: payload.imageSource || null
    });
  } catch (_error) {
    const url = chrome.runtime.getURL(`inspector.html?source=${encodeURIComponent(source)}`);
    await chrome.tabs.update(tabId, { url });
  }
}

function waitForTabLoaded(tabId) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 1500);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getPopupBounds() {
  const currentWindow = await chrome.windows.getLastFocused();
  const left = typeof currentWindow.left === "number" ? currentWindow.left : 0;
  const top = typeof currentWindow.top === "number" ? currentWindow.top : 0;
  const width = typeof currentWindow.width === "number" ? currentWindow.width : 1280;

  return {
    left: Math.max(0, left + width - POPUP_WIDTH - RIGHT_EDGE_OFFSET),
    top: Math.max(0, top + TOP_EDGE_OFFSET)
  };
}

async function captureSelectedImageFromTab(tab, imageUrl) {
  if (!tab?.id || !tab?.windowId || !chrome.scripting?.executeScript || !chrome.tabs?.captureVisibleTab) {
    return null;
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: locatePromptLensImageOnPage,
      args: [imageUrl]
    });

    const locatedImage = injection?.result;
    if (!locatedImage) {
      return null;
    }

    if (locatedImage.dataUrl) {
      return locatedImage.dataUrl;
    }

    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png"
    });

    return cropScreenshotToImage(screenshotDataUrl, locatedImage);
  } catch (_error) {
    return null;
  }
}

function locatePromptLensImageOnPage(imageUrl) {
  const normalizedTarget = normalizeUrl(imageUrl);
  const images = Array.from(document.images || []);
  const image =
    images.find((item) => normalizeUrl(item.currentSrc || item.src) === normalizedTarget) ||
    images.find((item) => {
      const source = normalizeUrl(item.currentSrc || item.src);
      return source && normalizedTarget && (source.includes(normalizedTarget) || normalizedTarget.includes(source));
    }) ||
    images
      .filter((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 20 && rect.height > 20;
      })
      .sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectB.width * rectB.height - rectA.width * rectA.height;
      })[0];

  if (!image) {
    return null;
  }

  const rect = image.getBoundingClientRect();
  const left = clampNumber(rect.left, 0, window.innerWidth);
  const top = clampNumber(rect.top, 0, window.innerHeight);
  const right = clampNumber(rect.right, 0, window.innerWidth);
  const bottom = clampNumber(rect.bottom, 0, window.innerHeight);
  const width = right - left;
  const height = bottom - top;

  if (width < 10 || height < 10) {
    return null;
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, image.naturalWidth || Math.round(width));
    canvas.height = Math.max(1, image.naturalHeight || Math.round(height));
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.92)
    };
  } catch (_error) {
    return {
      rect: { left, top, width, height },
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  function normalizeUrl(value) {
    try {
      return new URL(value, location.href).href;
    } catch (_error) {
      return String(value || "");
    }
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }
}

async function cropScreenshotToImage(screenshotDataUrl, locatedImage) {
  if (!screenshotDataUrl || !locatedImage?.rect || typeof OffscreenCanvas === "undefined") {
    return null;
  }

  const screenshotBlob = await (await fetch(screenshotDataUrl)).blob();
  const screenshotBitmap = await createImageBitmap(screenshotBlob);
  const scale = locatedImage.devicePixelRatio || 1;
  const rect = locatedImage.rect;

  const sx = clampNumber(Math.round(rect.left * scale), 0, screenshotBitmap.width);
  const sy = clampNumber(Math.round(rect.top * scale), 0, screenshotBitmap.height);
  const sw = clampNumber(Math.round(rect.width * scale), 1, screenshotBitmap.width - sx);
  const sh = clampNumber(Math.round(rect.height * scale), 1, screenshotBitmap.height - sy);

  const resizeRatio = Math.min(1, CAPTURE_MAX_EDGE / Math.max(sw, sh));
  const outputWidth = Math.max(1, Math.round(sw * resizeRatio));
  const outputHeight = Math.max(1, Math.round(sh * resizeRatio));
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const context = canvas.getContext("2d");
  context.drawImage(screenshotBitmap, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight);

  const outputBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: CAPTURE_JPEG_QUALITY
  });

  return blobToDataUrl(outputBlob);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

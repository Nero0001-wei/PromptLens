const MENU_ID = "reverse-prompt-image";
const INSPECTOR_WINDOW_ID_KEY = "inspectorWindowId";
const POPUP_WIDTH = 392;
const INITIAL_POPUP_HEIGHT = 540;
const RIGHT_EDGE_OFFSET = 20;
const TOP_EDGE_OFFSET = 84;

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

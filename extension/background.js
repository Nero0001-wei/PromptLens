const MENU_ID = "reverse-prompt-image";
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
  await openInspectorPopup("toolbar");
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) {
    return;
  }

  await chrome.storage.local.set({
    lastImageSource: {
      kind: "url",
      imageUrl: info.srcUrl,
      pageUrl: tab?.url || "",
      pageTitle: tab?.title || "",
      createdAt: new Date().toISOString()
    }
  });

  await openInspectorPopup("context-menu");
});

async function openInspectorPopup(source) {
  const url = chrome.runtime.getURL(`inspector.html?source=${encodeURIComponent(source)}`);
  const bounds = await getPopupBounds();

  await chrome.windows.create({
    url,
    type: "popup",
    width: POPUP_WIDTH,
    height: INITIAL_POPUP_HEIGHT,
    left: bounds.left,
    top: bounds.top,
    focused: true
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

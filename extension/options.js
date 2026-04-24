const backendBaseUrlInput = document.getElementById("backendBaseUrl");
const appTokenInput = document.getElementById("appToken");
const saveButton = document.getElementById("saveButton");
const saveStatus = document.getElementById("saveStatus");

init();

async function init() {
  const { backendBaseUrl, appToken } = await chrome.storage.sync.get(["backendBaseUrl", "appToken"]);
  backendBaseUrlInput.value = backendBaseUrl || "";
  appTokenInput.value = appToken || "";

  saveButton.addEventListener("click", async () => {
    await chrome.storage.sync.set({
      backendBaseUrl: backendBaseUrlInput.value.trim(),
      appToken: appTokenInput.value.trim()
    });

    saveStatus.textContent = "设置已保存。";
    saveStatus.className = "status-message is-success";
  });
}

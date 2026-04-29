const backendBaseUrlInput = document.getElementById("backendBaseUrl");
const appTokenInput = document.getElementById("appToken");
const saveButton = document.getElementById("saveButton");
const saveStatus = document.getElementById("saveStatus");
const environmentBadge = document.getElementById("environmentBadge");
const environmentHint = document.getElementById("environmentHint");

const ENVIRONMENTS = [
  {
    key: "dev",
    label: "DEV 开发环境",
    badgeClass: "environment-badge--dev",
    hostIncludes: "reverse-api-dev-xmpdkgbpue.cn-hangzhou.fcapp.run",
    hint: "当前请求会发送到开发函数 reverse-prompt-api-dev，适合本地测试。"
  },
  {
    key: "prod",
    label: "PROD 正式环境",
    badgeClass: "environment-badge--prod",
    hostIncludes: "reverseompt-api-uxifbiguie.cn-hangzhou.fcapp.run",
    hint: "当前请求会发送到正式函数 reverse-prompt-api，请谨慎用于线上发布。"
  }
];

init();

async function init() {
  const { backendBaseUrl, appToken } = await chrome.storage.sync.get(["backendBaseUrl", "appToken"]);
  backendBaseUrlInput.value = backendBaseUrl || "";
  appTokenInput.value = appToken || "";
  updateEnvironmentView(backendBaseUrlInput.value);

  backendBaseUrlInput.addEventListener("input", () => {
    updateEnvironmentView(backendBaseUrlInput.value);
    saveStatus.className = "status-message is-hidden";
  });

  saveButton.addEventListener("click", async () => {
    const backendBaseUrl = backendBaseUrlInput.value.trim();
    const appToken = appTokenInput.value.trim();

    await chrome.storage.sync.set({
      backendBaseUrl,
      appToken
    });

    updateEnvironmentView(backendBaseUrl);
    saveStatus.textContent = "设置已保存。";
    saveStatus.className = "status-message is-success";
  });
}

function updateEnvironmentView(rawUrl) {
  const value = rawUrl.trim();
  const environment = detectEnvironment(value);

  environmentBadge.textContent = environment.label;
  environmentBadge.className = `environment-badge ${environment.badgeClass}`;
  environmentHint.textContent = environment.hint;
}

function detectEnvironment(rawUrl) {
  if (!rawUrl) {
    return {
      label: "未配置",
      badgeClass: "environment-badge--unknown",
      hint: "填写后端地址后，会自动显示当前连接的是开发环境、正式环境或自定义环境。"
    };
  }

  const normalized = rawUrl.replace(/^https?:\/\//i, "").replace(/\/+$/g, "").toLowerCase();
  const matched = ENVIRONMENTS.find((environment) => normalized.includes(environment.hostIncludes));

  if (matched) {
    return matched;
  }

  return {
    label: "自定义环境",
    badgeClass: "environment-badge--custom",
    hint: "当前后端地址不是已知的 DEV 或 PROD 地址，请确认是否为临时测试函数。"
  };
}

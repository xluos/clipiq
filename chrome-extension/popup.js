const indicator = document.getElementById("indicator");
const primary = document.getElementById("status-primary");
const secondary = document.getElementById("status-secondary");
const tokenInput = document.getElementById("token");
const saveBtn = document.getElementById("save");
const reconnectBtn = document.getElementById("reconnect");

function applyStatus(status) {
  indicator.classList.remove("ok", "err", "connecting");
  if (status?.connected) {
    indicator.classList.add("ok");
    primary.textContent = "已连接";
    secondary.textContent = `${status.endpoint || "桌面端"} · ${new Date(status.since || Date.now()).toLocaleTimeString()}`;
  } else if (status?.error) {
    indicator.classList.add("err");
    primary.textContent = "未连接";
    secondary.textContent = status.error;
  } else {
    indicator.classList.add("connecting");
    primary.textContent = "连接中…";
    secondary.textContent = "等待桌面端响应";
  }
}

async function loadInitial() {
  const { token } = await chrome.storage.local.get("token");
  if (token) tokenInput.value = token;
  chrome.runtime.sendMessage({ type: "get-status" }, (status) => applyStatus(status));
}

saveBtn.addEventListener("click", () => {
  const token = tokenInput.value.trim();
  if (!token) {
    secondary.textContent = "token 不能为空";
    return;
  }
  saveBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "set-token", token }, () => {
    saveBtn.disabled = false;
  });
});

reconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => { /* status broadcast 会刷新 */ });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "bridge-status") applyStatus(msg.status);
});

loadInitial();

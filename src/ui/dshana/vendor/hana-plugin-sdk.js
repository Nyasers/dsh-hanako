// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Hana SDK authors — vendored browser SDK (Apache-2.0, see THIRD_PARTY_NOTICES.md).
//
// @hana/plugin-sdk 浏览器构建 dist/browser.js（宿主 0.930.1 配套，source-manifest 0.930.0），
// 从宿主随包 skills2set/hana-app-creator/assets/sdk/hana-plugin-sdk-0.0.0.tgz 原样引入。
// 提供 hana.api.fetch（App surface 会话凭据注入 X-Hana-App-Surface-Session）等浏览器面；
// 勿改动协议语义。升级 = 替换宿主配套 SDK 后随 App 发版。
// ../plugin-protocol/dist/index.js
var PLUGIN_UI_PROTOCOL = "hana.plugin.ui";
var PLUGIN_UI_PROTOCOL_VERSION = 1;
var APP_SURFACE_SESSION_HEADER = "X-Hana-App-Surface-Session";
var APP_SURFACE_SESSION_QUERY = "appSurfaceSession";
var PLUGIN_UI_ERROR_CODE = {
  BAD_MESSAGE: "BAD_MESSAGE",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  UNKNOWN_TYPE: "UNKNOWN_TYPE",
  CAPABILITY_DENIED: "CAPABILITY_DENIED",
  SLOT_DENIED: "SLOT_DENIED",
  TIMEOUT: "TIMEOUT",
  HOST_ERROR: "HOST_ERROR"
};
var PLUGIN_UI_CAPABILITY = {
  TOAST_SHOW: "toast.show",
  EXTERNAL_OPEN: "external.open",
  SESSION_FILE_OPEN: "sessionFile.open",
  RESOURCE_OPEN: "resource.open",
  RESOURCE_PICK: "resource.pick",
  RESOURCE_SAVE_FILE: "resource.saveFile",
  RESOURCE_REQUEST_ACCESS: "resource.requestAccess",
  UI_RESIZE: "ui.resize",
  CLIPBOARD_WRITE_TEXT: "clipboard.writeText",
  // 实例态（卡实例私有的草稿纸，随 Client Layout Profile 持久化，只在 card slot 生效）
  STATE_GET: "hana.state.get",
  STATE_SET: "hana.state.set",
  // 应用态（插件级 KV，pluginId 命名空间，经宿主 owner 凭证代调 server 存储）。
  // v1 插件专属的冻结兼容层能力，与上面的 v2 卡实例态 hana.state 并存，互不影响。
  STORAGE_GET: "hana.storage.get",
  STORAGE_GET_ALL: "hana.storage.getAll",
  STORAGE_SET: "hana.storage.set",
  STORAGE_DELETE: "hana.storage.delete",
  // 功能面板：插件把要显示的内容推给宿主，宿主用内置原语画（只在 card slot
  // 生效，面板是主卡的一块投影，不是第二个插件实例）
  PANEL_SET: "hana.panel.set",
  // 回传：把一次用户操作送进会话并唤醒 agent。只在 card slot 生效；
  // 手势由 SDK 注入层采集，作者不可自报。进模型走既有起回合授权。
  EMIT: "hana.emit",
  // 安静日志：写入独立活动仓，不唤醒 agent。只在 card slot 生效。
  TRACK: "hana.track",
  // 宿主驱动：看卡 / 点卡。只由宿主发 request，不是作者向宿主申请的能力。
  UI_ACTION: "hana.ui.action"
};
var PLUGIN_UI_HOST_EVENT = {
  THEME_CHANGED: "hana.theme.changed",
  SURFACE_RUNTIME_CHANGED: "hana.surface.runtime.changed",
  SURFACE_ENVELOPE_CHANGED: "hana.surface.envelope.changed",
  // 应用态变更广播：宿主消费 server 的 plugin-storage-changed 后，向同 pluginId 的
  // 所有已挂载插件卡 iframe 推送（不带值，只带 keys；订阅方自行重拉）
  STORAGE_CHANGED: "hana.storage.changed",
  // 用户在功能面板里点了什么：宿主把事件送回贡献这块面板的那张卡
  PANEL_EVENT: "hana.panel.event",
  // 到了声明的刷新节奏：宿主叫插件重推一次内容（面板不可见时不发）
  PANEL_REFRESH: "hana.panel.refresh"
};
var PLUGIN_CARD_STATE_MAX_BYTES = 64 * 1024;
var APP_STORAGE_CAPABILITY = {
  GET: "hana.app.storage.get",
  GET_ALL: "hana.app.storage.getAll",
  SET: "hana.app.storage.set",
  DELETE: "hana.app.storage.delete",
  KEYS: "hana.app.storage.keys"
};
var APP_STORAGE_HOST_EVENT = {
  CHANGED: "hana.app.storage.changed"
};
var MESSAGE_KINDS = /* @__PURE__ */ new Set([
  "event",
  "request",
  "response",
  "error"
]);
function isObject(value) {
  return typeof value === "object" && value !== null;
}
function badMessage(message) {
  return {
    ok: false,
    error: {
      code: PLUGIN_UI_ERROR_CODE.BAD_MESSAGE,
      message
    }
  };
}
function parsePluginUiMessage(value) {
  if (!isObject(value)) {
    return badMessage("Plugin UI messages must be objects.");
  }
  if (value.protocol !== PLUGIN_UI_PROTOCOL) {
    return badMessage("Plugin UI message protocol is missing or invalid.");
  }
  if (value.version !== PLUGIN_UI_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: {
        code: PLUGIN_UI_ERROR_CODE.UNSUPPORTED_VERSION,
        message: `Unsupported Plugin UI protocol version: ${String(value.version)}.`
      }
    };
  }
  if (typeof value.kind !== "string" || !MESSAGE_KINDS.has(value.kind)) {
    return badMessage("Plugin UI message kind is missing or invalid.");
  }
  if (typeof value.type !== "string" || value.type.trim() === "") {
    return badMessage("Plugin UI message type must be a non-empty string.");
  }
  const kind = value.kind;
  if (kind !== "event" && (typeof value.id !== "string" || value.id.trim() === "")) {
    return badMessage(`Plugin UI ${kind} messages must include a non-empty id.`);
  }
  if (kind === "error") {
    if (!isObject(value.error)) {
      return badMessage("Plugin UI error messages must include an error object.");
    }
    if (typeof value.error.code !== "string" || value.error.code.trim() === "") {
      return badMessage("Plugin UI error code must be a non-empty string.");
    }
    if (typeof value.error.message !== "string" || value.error.message.trim() === "") {
      return badMessage("Plugin UI error message must be a non-empty string.");
    }
  }
  return {
    ok: true,
    value
  };
}
var PLUGIN_MANIFEST_TOP_LEVEL_FIELDS = [
  "manifestVersion",
  "id",
  "name",
  "version",
  "description",
  "minAppVersion",
  "trust",
  "hidden",
  "activationEvents",
  "capabilities",
  "sensitiveCapabilities",
  "permissions",
  "network",
  "formFactors",
  "ui",
  "contributes",
  "dev"
];
var PLUGIN_MANIFEST_CONTRIBUTES_KEYS = [
  "cards",
  "agentTypes",
  "configuration",
  "settingsTab",
  "page",
  "widget"
];
var PLUGIN_V2_MANIFEST_CONTRIBUTES_KEYS = [
  "settings",
  "ui",
  "cards",
  "agentTypes",
  "messageRenderers",
  "providers",
  "previewers"
];
var PLUGIN_MANIFEST_TRUST_LEVELS = ["restricted", "full-access"];
var PLUGIN_MANIFEST_ACTIVATION_EVENT_NAMES = [
  "onStartup",
  "onPageOpen",
  "onWidgetOpen",
  "onToolCall",
  "onBusRequest"
];
var TOP_LEVEL_FIELD_SET = new Set(PLUGIN_MANIFEST_TOP_LEVEL_FIELDS);
var CONTRIBUTES_KEY_SET = new Set(PLUGIN_MANIFEST_CONTRIBUTES_KEYS);
var V2_CONTRIBUTES_KEY_SET = new Set(PLUGIN_V2_MANIFEST_CONTRIBUTES_KEYS);
var TRUST_LEVEL_SET = new Set(PLUGIN_MANIFEST_TRUST_LEVELS);
var ACTIVATION_EVENT_EXACT_SET = /* @__PURE__ */ new Set([
  "*",
  ...PLUGIN_MANIFEST_ACTIVATION_EVENT_NAMES
]);
var UI_HOST_CAPABILITY_VALUES = Object.values(PLUGIN_UI_CAPABILITY);
var UI_HOST_CAPABILITY_SET = new Set(UI_HOST_CAPABILITY_VALUES);

// src/index.ts
var HanaPluginError = class extends Error {
  name = "HanaPluginError";
  code;
  details;
  constructor(error) {
    super(error.message);
    this.code = error.code;
    this.details = error.details;
  }
};
var fallbackIdSeq = 0;
var DEFAULT_PLUGIN_MAX_FRAME_RATE = 60;
var MAX_PLUGIN_MAX_FRAME_RATE = 240;
function defaultIdFactory() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackIdSeq += 1;
  return `hana-plugin-${Date.now()}-${fallbackIdSeq}`;
}
function getBrowserWindow() {
  if (typeof window === "undefined") {
    throw new Error("@hana/plugin-sdk requires a browser iframe window.");
  }
  return window;
}
function safeOriginFromUrl(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
function resolveTargetOrigin(targetWindow, explicit) {
  if (explicit) return explicit;
  const hostOrigin = new URLSearchParams(targetWindow.location.search).get("hana-host-origin");
  if (hostOrigin) return hostOrigin;
  return safeOriginFromUrl(targetWindow.document.referrer) ?? "*";
}
var HANA_THEME_STYLE_ATTR = "data-hana-theme-style";
async function applyHostThemeStylesheet(doc, cssUrl) {
  const response = await fetch(cssUrl, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`hana theme stylesheet request failed with ${response.status}`);
  }
  const css = await response.text();
  const head = doc.head ?? doc.documentElement;
  if (!head) throw new Error("hana theme stylesheet has nowhere to attach");
  let element = doc.querySelector(`style[${HANA_THEME_STYLE_ATTR}]`);
  if (!element) {
    element = doc.createElement("style");
    element.setAttribute(HANA_THEME_STYLE_ATTR, "");
  }
  element.textContent = css;
  head.appendChild(element);
}
function readInitialTheme(targetWindow) {
  const params = new URLSearchParams(targetWindow.location.search);
  return {
    theme: params.get("hana-theme") ?? void 0,
    cssUrl: params.get("hana-css") ?? void 0
  };
}
function normalizeFrameRate(value, fallback = DEFAULT_PLUGIN_MAX_FRAME_RATE) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(MAX_PLUGIN_MAX_FRAME_RATE, Math.round(value)));
}
function createRuntimeSnapshot({
  visible,
  maxFrameRate,
  slot,
  reason
}) {
  const normalizedMaxFrameRate = visible ? normalizeFrameRate(maxFrameRate) : 0;
  const active = visible && normalizedMaxFrameRate > 0;
  return {
    visible,
    active,
    maxFrameRate: active ? normalizedMaxFrameRate : 0,
    motion: active ? "full" : "paused",
    ...slot === "page" || slot === "widget" || slot === "card" || slot === "settings" ? { slot } : {},
    ...reason ? { reason } : {}
  };
}
function readInitialRuntimeSnapshot(targetWindow) {
  const params = new URLSearchParams(targetWindow.location.search);
  const rawVisible = params.get("hana-visible");
  const visible = rawVisible === "0" || rawVisible === "false" ? false : true;
  const rawFrameRate = params.get("hana-max-fps");
  const parsedFrameRate = rawFrameRate === null ? NaN : Number(rawFrameRate);
  const maxFrameRate = Number.isFinite(parsedFrameRate) ? parsedFrameRate : DEFAULT_PLUGIN_MAX_FRAME_RATE;
  return createRuntimeSnapshot({
    visible,
    maxFrameRate,
    reason: "initial"
  });
}
function normalizeRuntimeSnapshotPayload(payload, current) {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload;
  const visible = typeof record.visible === "boolean" ? record.visible : current.visible;
  const requestedFrameRate = normalizeFrameRate(
    record.maxFrameRate,
    current.maxFrameRate > 0 ? current.maxFrameRate : DEFAULT_PLUGIN_MAX_FRAME_RATE
  );
  const active = typeof record.active === "boolean" ? record.active && visible && requestedFrameRate > 0 : visible && requestedFrameRate > 0;
  const rawMotion = record.motion;
  const motion = rawMotion === "full" || rawMotion === "reduced" || rawMotion === "paused" ? rawMotion : active ? "full" : "paused";
  const slot = typeof record.slot === "string" ? record.slot : current.slot;
  const reason = typeof record.reason === "string" ? record.reason : current.reason;
  return {
    visible,
    active,
    maxFrameRate: active ? requestedFrameRate : 0,
    motion: active ? motion : "paused",
    ...slot === "page" || slot === "widget" || slot === "card" || slot === "settings" ? { slot } : {},
    ...reason ? { reason } : {}
  };
}
function normalizeLegacyVisibilityPayload(payload, current) {
  if (typeof payload !== "object" || payload === null) return null;
  const visible = payload.visible;
  if (typeof visible !== "boolean") return null;
  return createRuntimeSnapshot({
    visible,
    maxFrameRate: visible && current.maxFrameRate > 0 ? current.maxFrameRate : DEFAULT_PLUGIN_MAX_FRAME_RATE,
    slot: current.slot,
    reason: "legacy-visibility"
  });
}
function areRuntimeSnapshotsEqual(a, b) {
  return a.visible === b.visible && a.active === b.active && a.maxFrameRate === b.maxFrameRate && a.motion === b.motion && a.slot === b.slot && a.reason === b.reason;
}
function copyEnvelope(envelope) {
  return {
    width: { ...envelope.width },
    height: { ...envelope.height }
  };
}
function normalizeEnvelopeAxis(value) {
  if (typeof value !== "object" || value === null) return null;
  const record = value;
  if (record.mode === "fixed") {
    if (typeof record.value !== "number" || !Number.isFinite(record.value)) return null;
    return { mode: "fixed", value: Math.round(record.value) };
  }
  if (record.mode === "flexible") {
    if (typeof record.max !== "number" || !Number.isFinite(record.max)) return null;
    return { mode: "flexible", max: Math.round(record.max) };
  }
  if (record.mode === "unbounded") {
    return { mode: "unbounded" };
  }
  return null;
}
function normalizeEnvelopePayload(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload;
  const width = normalizeEnvelopeAxis(record.width);
  const height = normalizeEnvelopeAxis(record.height);
  if (!width || !height) return null;
  return { width, height };
}
function isTrustedHostEvent(event, parentWindow, targetOrigin) {
  if (event.source !== parentWindow) return false;
  if (targetOrigin !== "*" && event.origin !== targetOrigin) return false;
  return true;
}
var UI_ACTION_SCAN_LIMIT = 600;
var UI_ACTION_OUTLINE_LIMIT = 120;
var UI_ACTION_TEXT_CAP = 4e3;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isVisibleElement(el) {
  if (!(el instanceof HTMLElement)) return true;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden") return false;
  return true;
}
function describeUiActionNode(el) {
  const html = el;
  const tagName = el.tagName.toLowerCase();
  const node = { tagName };
  if (typeof html.id === "string" && html.id) node.id = html.id.slice(0, 80);
  if (typeof html.className === "string" && html.className.trim()) {
    node.className = html.className.trim().slice(0, 120);
  }
  const text = html.textContent?.trim();
  if (text) node.text = text.slice(0, 160);
  if (html instanceof HTMLInputElement || html instanceof HTMLTextAreaElement) {
    if (html.disabled) node.disabled = true;
    if (html.type) node.type = html.type;
  }
  if (html.id) node.elementId = html.id;
  return node;
}
function describeUiActionDom(doc) {
  const outline = [];
  let visibleNodeCount = 0;
  let totalNodeCount = 0;
  const root = doc.body;
  if (!root) {
    return { outline, visibleNodeCount: 0, totalNodeCount: 0, truncated: false };
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let current = walker.currentNode;
  while (current && totalNodeCount < UI_ACTION_SCAN_LIMIT) {
    if (current instanceof Element) {
      totalNodeCount += 1;
      if (isVisibleElement(current)) {
        visibleNodeCount += 1;
        if (outline.length < UI_ACTION_OUTLINE_LIMIT) {
          outline.push(describeUiActionNode(current));
        }
      }
    }
    current = walker.nextNode();
  }
  return {
    outline,
    visibleNodeCount,
    totalNodeCount,
    truncated: current !== null
  };
}
function findUiActionElement(doc, elementId) {
  if (typeof elementId !== "string" || !elementId.trim()) return null;
  return doc.getElementById(elementId.trim());
}
function clickUiActionElement(el) {
  if (!(el instanceof HTMLElement)) {
    return { ok: false, error: "Target is not an element." };
  }
  if (el instanceof HTMLInputElement && (el.type === "file" || el.disabled)) {
    return { ok: false, error: "This element cannot be clicked." };
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    return { ok: false, error: "This element cannot be clicked." };
  }
  el.click();
  return { ok: true };
}
function typeUiActionElement(el, text) {
  const value = typeof text === "string" ? text.slice(0, UI_ACTION_TEXT_CAP) : "";
  if (el instanceof HTMLInputElement) {
    if (el.type === "file" || el.disabled || el.readOnly) {
      return { ok: false, error: "This element cannot accept text." };
    }
    el.value = `${el.value}${value}`;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  if (el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return { ok: false, error: "This element cannot accept text." };
    el.value = `${el.value}${value}`;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  return { ok: false, error: "This element cannot accept text." };
}
function performHostUiAction(doc, payload) {
  const action = isRecord(payload) && typeof payload.action === "string" ? payload.action : "";
  if (action === "describe_dom") {
    return { ok: true, result: describeUiActionDom(doc) };
  }
  if (action === "read_state") {
    return { ok: true, result: { state: {} } };
  }
  if (action === "click_element") {
    const el = findUiActionElement(doc, isRecord(payload) ? payload.elementId : null);
    if (!el) return { ok: false, code: "UI_ACTION_ELEMENT_NOT_FOUND", error: "No element matches this elementId." };
    const clicked = clickUiActionElement(el);
    if (clicked.ok === false) return { ok: false, code: "UI_ACTION_ELEMENT_NOT_OPERABLE", error: clicked.error };
    return { ok: true, result: { clicked: true } };
  }
  if (action === "type_text") {
    const el = findUiActionElement(doc, isRecord(payload) ? payload.elementId : null);
    if (!el) return { ok: false, code: "UI_ACTION_ELEMENT_NOT_FOUND", error: "No element matches this elementId." };
    const typed = typeUiActionElement(el, isRecord(payload) ? payload.text : "");
    if (typed.ok === false) return { ok: false, code: "UI_ACTION_ELEMENT_NOT_OPERABLE", error: typed.error };
    return { ok: true, result: { typed: true } };
  }
  if (action === "click_sequence" || action === "drag_element" || action === "press_key") {
    return { ok: false, code: "UI_ACTION_UNSUPPORTED_FOR_APP_CARD", error: `App cards do not support ${action}.` };
  }
  return { ok: false, code: "UI_ACTION_UNKNOWN_ACTION", error: `Unknown UI action: ${action || "(missing)"}.` };
}
function externalOpenPayload(input) {
  return typeof input === "string" ? { url: input } : input;
}
function clipboardWriteTextPayload(input) {
  return typeof input === "string" ? { text: input } : input;
}
function readAppIdFromIframeRoute(targetWindow) {
  const match = /^\/api\/apps\/([^/]+)\/ui(?:\/|$)/.exec(targetWindow.location.pathname || "");
  if (!match) {
    throw new Error("App asset/API URL helper requires an iframe route under /api/apps/:appId/ui/.");
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new Error("App asset/API URL helper could not decode the current app id.");
  }
}
function normalizeAssetPath(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Invalid plugin asset path.");
  }
  if (input.includes("\\") || input.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
    throw new Error("Invalid plugin asset path.");
  }
  const stripped = input.replace(/^\/+/, "");
  if (!stripped || stripped.startsWith("./")) {
    throw new Error("Invalid plugin asset path.");
  }
  const segments = stripped.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("Invalid plugin asset path.");
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}
function readAssetBase(targetWindow) {
  return new URLSearchParams(targetWindow.location.search).get("hana-asset-base") || null;
}
function pluginAssetUrl(targetWindow, input) {
  const assetPath = normalizeAssetPath(input);
  const assetBase = readAssetBase(targetWindow);
  if (!assetBase) {
    throw new Error(
      "hana.assets.url() requires the host-issued hana-asset-base query parameter: this page was not opened by the host with an asset base; hana.assets.url() only works inside a Hana app surface."
    );
  }
  const url = new URL(assetBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${assetPath}`;
  return url.toString();
}
function readSurfaceSession(targetWindow) {
  return new URLSearchParams(targetWindow.location.search).get(APP_SURFACE_SESSION_QUERY) || null;
}
function normalizePluginApiPath(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Invalid plugin API path.");
  }
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\\") || trimmed.includes("\0") || trimmed.includes("#") || trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new Error("Invalid plugin API path.");
  }
  const stripped = trimmed.replace(/^\/+/, "");
  if (!stripped || stripped.startsWith("./") || stripped === "api/apps" || stripped.startsWith("api/apps/")) {
    throw new Error("Invalid plugin API path. Use a route path relative to the current plugin.");
  }
  const queryIndex = stripped.indexOf("?");
  const rawPath = queryIndex >= 0 ? stripped.slice(0, queryIndex) : stripped;
  if (!rawPath) {
    throw new Error("Invalid plugin API path.");
  }
  const segments = rawPath.split("/");
  for (const segment of segments) {
    if (!segment) throw new Error("Invalid plugin API path.");
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Invalid plugin API path.");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("Invalid plugin API path.");
    }
  }
  const parsed = new URL(`http://hana.local/${stripped}`);
  const safePath = segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join("/");
  return `${safePath}${parsed.search}`;
}
function pluginApiUrl(targetWindow, input) {
  const appId = readAppIdFromIframeRoute(targetWindow);
  const apiPath = normalizePluginApiPath(input);
  return `${targetWindow.location.origin}/api/apps/${encodeURIComponent(appId)}/routes/${apiPath}`;
}
function pluginApiFetch(targetWindow, input, init, documentBindingId) {
  const surfaceSession = readSurfaceSession(targetWindow);
  if (!surfaceSession) {
    throw new Error("hana.api.fetch requires appSurfaceSession in the iframe URL.");
  }
  const fetchImpl = targetWindow.fetch?.bind(targetWindow) ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error("hana.api.fetch requires window.fetch.");
  }
  const requestInit = init ?? {};
  const headers = new Headers(requestInit.headers);
  headers.set(APP_SURFACE_SESSION_HEADER, surfaceSession);
  if (documentBindingId) headers.set("X-Hana-Document-Binding", documentBindingId);
  return fetchImpl(pluginApiUrl(targetWindow, input), {
    ...requestInit,
    headers
  });
}
function readUserGesture(targetWindow) {
  try {
    const nav = targetWindow.navigator;
    if (nav.userActivation && typeof nav.userActivation.isActive === "boolean") {
      return nav.userActivation.isActive === true;
    }
  } catch {
  }
  try {
    const current = targetWindow.event;
    return !!(current && current.isTrusted);
  } catch {
  }
  return false;
}
function appStorageScopesMatch(subscriberScope, eventScope) {
  if (typeof eventScope !== "object" || eventScope === null) return false;
  const es = eventScope;
  if (subscriberScope.kind === "global") return es.kind === "global";
  return es.kind === "agent" && es.agentId === subscriberScope.agentId;
}
function createHanaPluginSdk(options = {}) {
  const targetWindow = options.targetWindow ?? getBrowserWindow();
  const parentWindow = options.parentWindow ?? targetWindow.parent;
  const targetOrigin = resolveTargetOrigin(targetWindow, options.targetOrigin);
  const requestTimeoutMs = options.requestTimeoutMs ?? 1e4;
  const idFactory = options.idFactory ?? defaultIdFactory;
  const themeFollowEnabled = options.followHostTheme !== false;
  let themeSnapshot = readInitialTheme(targetWindow);
  let runtimeSnapshot = readInitialRuntimeSnapshot(targetWindow);
  let envelopeSnapshot = null;
  const themeSubscribers = /* @__PURE__ */ new Set();
  const envelopeSubscribers = /* @__PURE__ */ new Set();
  const lifecycleSubscribers = /* @__PURE__ */ new Set();
  const storageChangedSubscribers = /* @__PURE__ */ new Set();
  const appStorageChangedSubscribers = /* @__PURE__ */ new Set();
  const panelEventSubscribers = /* @__PURE__ */ new Set();
  const panelRefreshSubscribers = /* @__PURE__ */ new Set();
  let documentBindingId = null;
  let documentRequestHandler = null;
  let documentViewRequestHandler = null;
  const animationCallbacks = /* @__PURE__ */ new Map();
  let nextAnimationHandle = 1;
  let animationPumpCancel = null;
  let lastAnimationFrameTime = null;
  function followHostTheme(cssUrl) {
    if (!themeFollowEnabled || !cssUrl) return;
    const doc = targetWindow.document;
    if (!doc) return;
    void applyHostThemeStylesheet(doc, cssUrl).catch((error) => {
      if (options.onThemeError) {
        options.onThemeError(error);
        return;
      }
      console.error("[hana] failed to follow host theme", error);
    });
  }
  function post(message) {
    parentWindow.postMessage(message, targetOrigin);
  }
  function postEvent(type, payload) {
    const message = {
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      kind: "event",
      type
    };
    if (payload !== void 0) message.payload = payload;
    post(message);
  }
  function requestNativeAnimationFrame(callback) {
    const requestFrame = targetWindow.requestAnimationFrame?.bind(targetWindow);
    const cancelFrame = targetWindow.cancelAnimationFrame?.bind(targetWindow);
    if (requestFrame && cancelFrame) {
      const handle = requestFrame(callback);
      return () => cancelFrame(handle);
    }
    const timeout = targetWindow.setTimeout(() => {
      const now = targetWindow.performance?.now?.() ?? Date.now();
      callback(now);
    }, Math.max(1, Math.round(1e3 / Math.max(runtimeSnapshot.maxFrameRate, DEFAULT_PLUGIN_MAX_FRAME_RATE))));
    return () => targetWindow.clearTimeout(timeout);
  }
  function cancelAnimationPump() {
    if (!animationPumpCancel) return;
    animationPumpCancel();
    animationPumpCancel = null;
  }
  function scheduleAnimationPump() {
    if (animationPumpCancel || animationCallbacks.size === 0) return;
    if (!runtimeSnapshot.active || runtimeSnapshot.maxFrameRate <= 0) return;
    animationPumpCancel = requestNativeAnimationFrame((time) => {
      animationPumpCancel = null;
      if (!runtimeSnapshot.active || runtimeSnapshot.maxFrameRate <= 0) return;
      const frameInterval = 1e3 / runtimeSnapshot.maxFrameRate;
      if (lastAnimationFrameTime !== null && time >= lastAnimationFrameTime && time - lastAnimationFrameTime < frameInterval) {
        scheduleAnimationPump();
        return;
      }
      lastAnimationFrameTime = time;
      const callbacks = Array.from(animationCallbacks.entries());
      for (const [handle, callback] of callbacks) {
        if (!animationCallbacks.delete(handle)) continue;
        try {
          callback(time);
        } catch (err) {
          targetWindow.setTimeout(() => {
            throw err;
          }, 0);
        }
      }
      scheduleAnimationPump();
    });
  }
  function setRuntimeSnapshot(next) {
    if (areRuntimeSnapshotsEqual(runtimeSnapshot, next)) return;
    runtimeSnapshot = next;
    for (const callback of lifecycleSubscribers) callback({ ...runtimeSnapshot });
    if (!runtimeSnapshot.active || runtimeSnapshot.maxFrameRate <= 0) {
      cancelAnimationPump();
      return;
    }
    scheduleAnimationPump();
  }
  function onHostMessage(event) {
    if (!isTrustedHostEvent(event, parentWindow, targetOrigin)) return;
    if (typeof event.data === "object" && event.data !== null && event.data.protocol === void 0 && event.data.type === "visibility-changed") {
      const next = normalizeLegacyVisibilityPayload(
        event.data.payload,
        runtimeSnapshot
      );
      if (next) setRuntimeSnapshot(next);
      return;
    }
    const parsed = parsePluginUiMessage(event.data);
    if (!parsed.ok) return;
    const message = parsed.value;
    if (message.kind === "request" && message.type === "hana.document.view-request") {
      const record = typeof message.payload === "object" && message.payload !== null ? message.payload : null;
      const requestId = record && typeof record.requestId === "string" ? record.requestId : "";
      const documentId = record && typeof record.documentId === "string" ? record.documentId : "";
      const viewId = record && typeof record.viewId === "string" ? record.viewId : "";
      const revision = record?.revision;
      const method = record && typeof record.method === "string" ? record.method.trim() : "";
      if (!requestId || !documentId || !viewId || !method || method.length > 128 || !Number.isSafeInteger(revision) || Number(revision) < 0) {
        post({
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          id: message.id,
          kind: "error",
          type: message.type,
          error: { code: "DOCUMENT_VIEW_REQUEST_INVALID", message: "Invalid document view request." }
        });
        return;
      }
      if (!documentViewRequestHandler) {
        post({
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          id: message.id,
          kind: "error",
          type: message.type,
          error: { code: "DOCUMENT_VIEW_REQUEST_UNHANDLED", message: "The document view cannot handle this request." }
        });
        return;
      }
      const payload = record?.payload;
      const handler = documentViewRequestHandler;
      void Promise.resolve().then(() => handler({
        requestId,
        documentId,
        viewId,
        revision,
        method,
        ...Object.prototype.hasOwnProperty.call(record, "payload") ? { payload } : {}
      })).then((result) => {
        post({ protocol: PLUGIN_UI_PROTOCOL, version: PLUGIN_UI_PROTOCOL_VERSION, id: message.id, kind: "response", type: message.type, payload: result });
      }, (error) => {
        post({
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          id: message.id,
          kind: "error",
          type: message.type,
          error: { code: "DOCUMENT_VIEW_REQUEST_FAILED", message: error instanceof Error ? error.message : "Document view request failed." }
        });
      });
      return;
    }
    if (message.kind === "request" && message.type === "hana.document.request") {
      const payload = message.payload;
      const record = typeof payload === "object" && payload !== null ? payload : null;
      const requestId = record && typeof record.requestId === "string" ? record.requestId : "";
      const kind = record?.kind;
      const revision = record?.revision;
      if (!requestId || !["save", "prepareClose", "revert", "undo", "redo"].includes(String(kind)) || !Number.isSafeInteger(revision)) {
        post({
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          id: message.id,
          kind: "error",
          type: message.type,
          error: { code: "DOCUMENT_REQUEST_INVALID", message: "Invalid document request." }
        });
        return;
      }
      if (!documentRequestHandler) {
        post({
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          id: message.id,
          kind: "error",
          type: message.type,
          error: { code: "DOCUMENT_REQUEST_UNHANDLED", message: "The document editor cannot handle this request." }
        });
        return;
      }
      const request2 = {
        requestId,
        kind,
        revision
      };
      void Promise.resolve(documentRequestHandler(request2)).then((result) => {
        post({ protocol: PLUGIN_UI_PROTOCOL, version: PLUGIN_UI_PROTOCOL_VERSION, id: message.id, kind: "response", type: message.type, payload: result });
      }, (error) => {
        post({
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          id: message.id,
          kind: "error",
          type: message.type,
          error: { code: "DOCUMENT_REQUEST_FAILED", message: error instanceof Error ? error.message : "Document request failed." }
        });
      });
      return;
    }
    if (message.kind === "request" && message.type === PLUGIN_UI_CAPABILITY.UI_ACTION) {
      const doc = targetWindow.document;
      const outcome = doc ? performHostUiAction(doc, message.payload) : { ok: false, code: "UI_ACTION_DOCUMENT_UNAVAILABLE", error: "No document is available." };
      if (outcome.ok === true) {
        post({
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          id: message.id,
          kind: "response",
          type: PLUGIN_UI_CAPABILITY.UI_ACTION,
          payload: outcome.result
        });
      } else {
        post({
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          id: message.id,
          kind: "error",
          type: PLUGIN_UI_CAPABILITY.UI_ACTION,
          error: { code: outcome.code, message: outcome.error }
        });
      }
      return;
    }
    if (message.kind !== "event") return;
    if (message.type === "hana.document.binding") {
      const payload = message.payload;
      const access = typeof payload === "object" && payload !== null ? payload.access : null;
      documentBindingId = typeof access?.bindingId === "string" && access.bindingId ? access.bindingId : null;
      return;
    }
    if (message.type === PLUGIN_UI_HOST_EVENT.THEME_CHANGED) {
      if (typeof message.payload !== "object" || message.payload === null) return;
      const payload = message.payload;
      themeSnapshot = {
        theme: typeof payload.theme === "string" ? payload.theme : themeSnapshot.theme,
        cssUrl: typeof payload.cssUrl === "string" ? payload.cssUrl : themeSnapshot.cssUrl
      };
      for (const callback of themeSubscribers) callback({ ...themeSnapshot });
      followHostTheme(themeSnapshot.cssUrl);
      return;
    }
    if (message.type === PLUGIN_UI_HOST_EVENT.SURFACE_ENVELOPE_CHANGED) {
      const next = normalizeEnvelopePayload(message.payload);
      if (!next) return;
      envelopeSnapshot = next;
      for (const callback of envelopeSubscribers) callback(copyEnvelope(envelopeSnapshot));
      return;
    }
    if (message.type === PLUGIN_UI_HOST_EVENT.SURFACE_RUNTIME_CHANGED) {
      const next = normalizeRuntimeSnapshotPayload(message.payload, runtimeSnapshot);
      if (next) setRuntimeSnapshot(next);
      return;
    }
    if (message.type === PLUGIN_UI_HOST_EVENT.STORAGE_CHANGED) {
      if (typeof message.payload !== "object" || message.payload === null) return;
      const rawKeys = message.payload.keys;
      const keys = Array.isArray(rawKeys) ? rawKeys.filter((k) => typeof k === "string") : [];
      for (const callback of storageChangedSubscribers) callback(keys.slice());
      return;
    }
    if (message.type === APP_STORAGE_HOST_EVENT.CHANGED) {
      if (typeof message.payload !== "object" || message.payload === null) return;
      const payload = message.payload;
      const rawKeys = payload.keys;
      const keys = Array.isArray(rawKeys) ? rawKeys.filter((k) => typeof k === "string") : [];
      for (const entry of appStorageChangedSubscribers) {
        if (appStorageScopesMatch(entry.scope, payload.scope)) entry.callback(keys.slice());
      }
      return;
    }
    if (message.type === PLUGIN_UI_HOST_EVENT.PANEL_EVENT) {
      if (typeof message.payload !== "object" || message.payload === null) return;
      const payload = message.payload;
      const sectionId = typeof payload.sectionId === "string" ? payload.sectionId : null;
      const kind = payload.kind;
      if (!sectionId || kind !== "select" && kind !== "action" && kind !== "toggle") return;
      const event2 = {
        sectionId,
        kind,
        ...typeof payload.itemId === "string" ? { itemId: payload.itemId } : {},
        ...typeof payload.checked === "boolean" ? { checked: payload.checked } : {}
      };
      for (const callback of panelEventSubscribers) callback(event2);
      return;
    }
    if (message.type === PLUGIN_UI_HOST_EVENT.PANEL_REFRESH) {
      for (const callback of panelRefreshSubscribers) callback();
    }
  }
  targetWindow.addEventListener("message", onHostMessage);
  function request(type, payload, requestOptions = {}) {
    const id = idFactory();
    const timeoutMs = requestOptions.timeoutMs ?? requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        targetWindow.removeEventListener("message", onMessage);
        targetWindow.clearTimeout(timeout);
      };
      const onMessage = (event) => {
        if (!isTrustedHostEvent(event, parentWindow, targetOrigin)) return;
        const parsed = parsePluginUiMessage(event.data);
        if (!parsed.ok) return;
        const message2 = parsed.value;
        if (message2.id !== id || message2.type !== type) return;
        if (message2.kind === "response") {
          cleanup();
          resolve(message2.payload);
        }
        if (message2.kind === "error" && message2.error) {
          cleanup();
          reject(new HanaPluginError(message2.error));
        }
      };
      const timeout = targetWindow.setTimeout(() => {
        cleanup();
        reject(new HanaPluginError({
          code: "TIMEOUT",
          message: `Plugin host request timed out: ${type}.`
        }));
      }, timeoutMs);
      targetWindow.addEventListener("message", onMessage);
      const message = {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id,
        kind: "request",
        type
      };
      if (payload !== void 0) message.payload = payload;
      post(message);
    });
  }
  function makeAppStorageScope(scope) {
    return {
      get(key, options2) {
        return request(APP_STORAGE_CAPABILITY.GET, { scope, key }, options2);
      },
      getAll(options2) {
        return request(APP_STORAGE_CAPABILITY.GET_ALL, { scope }, options2);
      },
      set(key, value, options2) {
        return request(APP_STORAGE_CAPABILITY.SET, { scope, key, value }, options2);
      },
      delete(key, options2) {
        return request(APP_STORAGE_CAPABILITY.DELETE, { scope, key }, options2);
      },
      keys(options2) {
        return request(APP_STORAGE_CAPABILITY.KEYS, { scope }, options2);
      },
      onChanged(callback) {
        if (scope.kind === "agent" && !scope.agentId) {
          throw new Error(
            "hana.storage.agent() with no agentId cannot subscribe with onChanged \u2014 a subscription outlives any single request, so pass an explicit agentId to subscribe to a stable scope."
          );
        }
        const entry = { scope, callback };
        appStorageChangedSubscribers.add(entry);
        return () => {
          appStorageChangedSubscribers.delete(entry);
        };
      }
    };
  }
  return {
    ready(payload) {
      postEvent("hana.ready", payload);
    },
    assets: {
      url(assetPath) {
        return pluginAssetUrl(targetWindow, assetPath);
      }
    },
    api: {
      url(apiPath) {
        return pluginApiUrl(targetWindow, apiPath);
      },
      fetch(apiPath, init) {
        return pluginApiFetch(targetWindow, apiPath, init, documentBindingId);
      }
    },
    ui: {
      resize(size) {
        postEvent(PLUGIN_UI_CAPABILITY.UI_RESIZE, size);
      }
    },
    theme: {
      getSnapshot() {
        return { ...themeSnapshot };
      },
      subscribe(callback) {
        themeSubscribers.add(callback);
        callback({ ...themeSnapshot });
        return () => {
          themeSubscribers.delete(callback);
        };
      }
    },
    envelope: {
      getSnapshot() {
        return envelopeSnapshot ? copyEnvelope(envelopeSnapshot) : null;
      },
      subscribe(callback) {
        envelopeSubscribers.add(callback);
        callback(envelopeSnapshot ? copyEnvelope(envelopeSnapshot) : null);
        return () => {
          envelopeSubscribers.delete(callback);
        };
      }
    },
    lifecycle: {
      getSnapshot() {
        return { ...runtimeSnapshot };
      },
      subscribe(callback) {
        lifecycleSubscribers.add(callback);
        callback({ ...runtimeSnapshot });
        return () => {
          lifecycleSubscribers.delete(callback);
        };
      }
    },
    performance: {
      requestAnimationFrame(callback) {
        const handle = nextAnimationHandle;
        nextAnimationHandle += 1;
        animationCallbacks.set(handle, callback);
        scheduleAnimationPump();
        return handle;
      },
      cancelAnimationFrame(handle) {
        animationCallbacks.delete(handle);
        if (animationCallbacks.size === 0) cancelAnimationPump();
      }
    },
    host: {
      request
    },
    toast: {
      show(input, options2) {
        return request(PLUGIN_UI_CAPABILITY.TOAST_SHOW, input, options2);
      }
    },
    external: {
      open(input, options2) {
        return request(PLUGIN_UI_CAPABILITY.EXTERNAL_OPEN, externalOpenPayload(input), options2);
      }
    },
    clipboard: {
      writeText(input, options2) {
        return request(
          PLUGIN_UI_CAPABILITY.CLIPBOARD_WRITE_TEXT,
          clipboardWriteTextPayload(input),
          options2
        );
      }
    },
    resources: {
      open(input, options2) {
        return request(PLUGIN_UI_CAPABILITY.RESOURCE_OPEN, input, options2);
      },
      pick(input = {}, options2) {
        return request(PLUGIN_UI_CAPABILITY.RESOURCE_PICK, input, options2);
      },
      saveFile(input, options2) {
        return request(PLUGIN_UI_CAPABILITY.RESOURCE_SAVE_FILE, input, options2);
      },
      requestAccess(input, options2) {
        return request(
          PLUGIN_UI_CAPABILITY.RESOURCE_REQUEST_ACCESS,
          input,
          options2
        );
      }
    },
    document: {
      getContext(options2) {
        return request("hana.document.get-context", void 0, options2);
      },
      read(options2) {
        return request("hana.document.read", void 0, options2);
      },
      reportStatus(status, options2) {
        return request("hana.document.report-status", status, options2);
      },
      open(input, options2) {
        return request("hana.document.open", input, options2);
      },
      rebind(input, options2) {
        return request("hana.document.rebind", input, options2);
      },
      openDrop(event, options2) {
        if (event.defaultPrevented) return Promise.resolve(null);
        const dragId = event.dataTransfer?.getData("application/x-hana-file-drag") || "";
        if (dragId) return request("hana.document.open-drop", { dragId }, options2);
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length !== 1) return Promise.resolve(null);
        return request("hana.document.open-drop", { file: files[0] }, options2);
      },
      onRequest(handler) {
        documentRequestHandler = handler;
        return () => {
          if (documentRequestHandler === handler) documentRequestHandler = null;
        };
      },
      onViewRequest(handler) {
        documentViewRequestHandler = handler;
        return () => {
          if (documentViewRequestHandler === handler) documentViewRequestHandler = null;
        };
      }
    },
    state: {
      get(key, options2) {
        const payload = typeof key === "string" && key ? { key } : {};
        return request(PLUGIN_UI_CAPABILITY.STATE_GET, payload, options2);
      },
      set(keyOrState, value, options2) {
        const payload = typeof keyOrState === "string" ? { key: keyOrState, value } : { state: keyOrState };
        return request(PLUGIN_UI_CAPABILITY.STATE_SET, payload, options2);
      }
    },
    storage: {
      get(key, options2) {
        return request(PLUGIN_UI_CAPABILITY.STORAGE_GET, { key }, options2);
      },
      getAll(options2) {
        return request(PLUGIN_UI_CAPABILITY.STORAGE_GET_ALL, {}, options2);
      },
      set(key, value, options2) {
        return request(PLUGIN_UI_CAPABILITY.STORAGE_SET, { key, value }, options2);
      },
      delete(key, options2) {
        return request(PLUGIN_UI_CAPABILITY.STORAGE_DELETE, { key }, options2);
      },
      onChanged(callback) {
        storageChangedSubscribers.add(callback);
        return () => {
          storageChangedSubscribers.delete(callback);
        };
      },
      global: makeAppStorageScope({ kind: "global" }),
      agent(agentId) {
        return makeAppStorageScope({ kind: "agent", agentId });
      }
    },
    emit(name, payload, to, options2) {
      const wire = {
        name,
        userGesture: readUserGesture(targetWindow)
      };
      if (arguments.length >= 2) wire.payload = payload;
      if (typeof to === "string" && to.trim()) wire.to = to.trim();
      return request(PLUGIN_UI_CAPABILITY.EMIT, wire, options2);
    },
    track(name, payload, options2) {
      const wire = { name };
      if (arguments.length >= 2) wire.payload = payload;
      return request(PLUGIN_UI_CAPABILITY.TRACK, wire, options2);
    },
    panel: {
      set(props, options2) {
        return request(PLUGIN_UI_CAPABILITY.PANEL_SET, props, options2);
      },
      onEvent(callback) {
        panelEventSubscribers.add(callback);
        return () => {
          panelEventSubscribers.delete(callback);
        };
      },
      onRefresh(callback) {
        panelRefreshSubscribers.add(callback);
        return () => {
          panelRefreshSubscribers.delete(callback);
        };
      }
    }
  };
}
var singleton = null;
function getSingleton() {
  singleton ??= createHanaPluginSdk();
  return singleton;
}
var hana = {
  ready(payload) {
    return getSingleton().ready(payload);
  },
  assets: {
    url(assetPath) {
      return getSingleton().assets.url(assetPath);
    }
  },
  api: {
    url(apiPath) {
      return getSingleton().api.url(apiPath);
    },
    fetch(apiPath, init) {
      return getSingleton().api.fetch(apiPath, init);
    }
  },
  ui: {
    resize(size) {
      return getSingleton().ui.resize(size);
    }
  },
  theme: {
    getSnapshot() {
      return getSingleton().theme.getSnapshot();
    },
    subscribe(callback) {
      return getSingleton().theme.subscribe(callback);
    }
  },
  envelope: {
    getSnapshot() {
      return getSingleton().envelope.getSnapshot();
    },
    subscribe(callback) {
      return getSingleton().envelope.subscribe(callback);
    }
  },
  lifecycle: {
    getSnapshot() {
      return getSingleton().lifecycle.getSnapshot();
    },
    subscribe(callback) {
      return getSingleton().lifecycle.subscribe(callback);
    }
  },
  performance: {
    requestAnimationFrame(callback) {
      return getSingleton().performance.requestAnimationFrame(callback);
    },
    cancelAnimationFrame(handle) {
      return getSingleton().performance.cancelAnimationFrame(handle);
    }
  },
  host: {
    request(type, payload, options) {
      return getSingleton().host.request(type, payload, options);
    }
  },
  toast: {
    show(input, options) {
      return getSingleton().toast.show(input, options);
    }
  },
  external: {
    open(input, options) {
      return getSingleton().external.open(input, options);
    }
  },
  clipboard: {
    writeText(input, options) {
      return getSingleton().clipboard.writeText(input, options);
    }
  },
  resources: {
    open(input, options) {
      return getSingleton().resources.open(input, options);
    },
    pick(input, options) {
      return getSingleton().resources.pick(input, options);
    },
    saveFile(input, options) {
      return getSingleton().resources.saveFile(input, options);
    },
    requestAccess(input, options) {
      return getSingleton().resources.requestAccess(input, options);
    }
  },
  document: {
    getContext(options) {
      return getSingleton().document.getContext(options);
    },
    read(options) {
      return getSingleton().document.read(options);
    },
    reportStatus(status, options) {
      return getSingleton().document.reportStatus(status, options);
    },
    open(input, options) {
      return getSingleton().document.open(input, options);
    },
    rebind(input, options) {
      return getSingleton().document.rebind(input, options);
    },
    openDrop(event, options) {
      return getSingleton().document.openDrop(event, options);
    },
    onRequest(handler) {
      return getSingleton().document.onRequest(handler);
    },
    onViewRequest(handler) {
      return getSingleton().document.onViewRequest(handler);
    }
  },
  state: {
    get(key, options) {
      return getSingleton().state.get(key, options);
    },
    set(keyOrState, value, options) {
      return getSingleton().state.set(keyOrState, value, options);
    }
  },
  storage: {
    get(key, options) {
      return getSingleton().storage.get(key, options);
    },
    getAll(options) {
      return getSingleton().storage.getAll(options);
    },
    set(key, value, options) {
      return getSingleton().storage.set(key, value, options);
    },
    delete(key, options) {
      return getSingleton().storage.delete(key, options);
    },
    onChanged(callback) {
      return getSingleton().storage.onChanged(callback);
    },
    get global() {
      return getSingleton().storage.global;
    },
    agent(agentId) {
      return getSingleton().storage.agent(agentId);
    }
  },
  emit(name, payload, to, options) {
    return getSingleton().emit(name, payload, to, options);
  },
  track(name, payload, options) {
    return getSingleton().track(name, payload, options);
  },
  panel: {
    set(props, options) {
      return getSingleton().panel.set(props, options);
    },
    onEvent(callback) {
      return getSingleton().panel.onEvent(callback);
    },
    onRefresh(callback) {
      return getSingleton().panel.onRefresh(callback);
    }
  }
};
export {
  HanaPluginError,
  createHanaPluginSdk,
  hana
};

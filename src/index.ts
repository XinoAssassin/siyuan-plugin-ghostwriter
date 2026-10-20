import { Plugin, Setting, getAllEditor, showMessage, IProtyle } from "siyuan";
import { GhostWriter } from "./ghost";
import {
  DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE, GhostWriterError, REQUEST_TIMEOUT_MS, normalizeBaseURL, parseExtraBody,
} from "./llm";
import "./index.css";

export interface GWConfig {
  enabled: boolean;
  baseURL: string;
  apiKey: string;
  model: string;
  delay: number;
  contextChars: number;
  triggerChars: string;
  useProxy: boolean;
  chainAfterAccept: boolean;
  /** 合并进请求体的额外 JSON，用于关闭思考模式等厂商参数 */
  extraBody: string;
  /** 系统提示词，空串表示使用默认值（与默认值相同时保存为空串，默认值更新后自动生效） */
  systemPrompt: string;
  /** 用户消息模板，变量：{{title}} {{before}} {{current}}；空串表示使用默认值 */
  userTemplate: string;
  temperature: number;
}

const DEFAULT_CONFIG: GWConfig = {
  enabled: true,
  baseURL: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-flash",
  delay: 400,
  contextChars: 1500,
  triggerChars: "，。！？；：,.!?;:",
  useProxy: false,
  chainAfterAccept: true,
  extraBody: '{"thinking":{"type":"disabled"}}',
  systemPrompt: "",
  userTemplate: "",
  temperature: 0.7,
};

const STORAGE = "config.json";
/** 已手动开启预测的文档（root ID），默认全部关闭 */
const DOCS_STORAGE = "docs.json";
const BREADCRUMB_ID = "gw-doc-toggle";
/** 同一条错误提示的最短间隔 */
const ERROR_REPEAT_MS = 60000;
const ERROR_MAX_CHARS = 300;
const ICON_ID = "iconGhostWriter";

export default class GhostWriterPlugin extends Plugin {
  config: GWConfig = { ...DEFAULT_CONFIG };
  private writers = new Map<HTMLElement, GhostWriter>();
  private enabledDocs = new Set<string>();
  private breadcrumbId = BREADCRUMB_ID;
  private errorShownAt = new Map<string, number>();

  async onload() {
    this.loadConfig(await this.loadData(STORAGE));
    const docs = await this.loadData(DOCS_STORAGE);
    if (Array.isArray(docs?.enabled)) docs.enabled.forEach((id: string) => this.enabledDocs.add(id));
    this.initSetting();

    this.addIcons(`<symbol id="${ICON_ID}" viewBox="0 0 32 32">
      <path d="M16 3c-6.1 0-11 4.9-11 11v14.2c0 .8.9 1.2 1.5.7l2.6-2.2 2.6 2.2c.4.3.9.3 1.3 0L16 26.7l3 2.2c.4.3.9.3 1.3 0l2.6-2.2 2.6 2.2c.6.5 1.5.1 1.5-.7V14C27 7.9 22.1 3 16 3zm-4.5 13a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm9 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>
    </symbol>`);
    this.breadcrumbId = this.addBreadcrumbButton({
      id: BREADCRUMB_ID,
      icon: ICON_ID,
      title: (this.i18n as Record<string, string>).docToggle,
      callback: (_e, protyle) => this.toggleDoc(protyle),
    });
    this.eventBus.on("click-editortitleicon", this.onTitleMenu);

    this.addCommand({
      langKey: "docToggle",
      hotkey: "",
      editorCallback: (protyle: IProtyle) => this.toggleDoc(protyle),
    });

    this.eventBus.on("loaded-protyle-static", this.onLoaded);
    this.eventBus.on("loaded-protyle-dynamic", this.onLoaded);
    this.eventBus.on("switch-protyle", this.onSwitch);
    this.eventBus.on("destroy-protyle", this.onDestroy);

    this.addCommand({
      langKey: "toggle",
      hotkey: "⌥⇧G",
      callback: () => {
        this.config.enabled = !this.config.enabled;
        this.saveData(STORAGE, this.config);
        showMessage(`Ghost Writer: ${this.config.enabled ? "ON" : "OFF"}`);
        this.hideAllIfDisabled();
      },
    });
  }

  /** 全局开关关闭后收起所有编辑器里的建议（快捷键和设置保存共用） */
  hideAllIfDisabled() {
    if (!this.config.enabled) this.writers.forEach((w) => w.hide());
  }

  /** 只接收与默认值同类型的已知字段；旧配置缺少的字段保持默认值 */
  private loadConfig(saved: unknown) {
    if (!saved || typeof saved !== "object") return;
    const target = this.config as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
      if (key in DEFAULT_CONFIG && typeof value === typeof DEFAULT_CONFIG[key as keyof GWConfig]) target[key] = value;
    }
    if (this.config.systemPrompt.trim() === DEFAULT_SYSTEM_PROMPT) this.config.systemPrompt = "";
    if (this.config.userTemplate.trim() === DEFAULT_USER_TEMPLATE) this.config.userTemplate = "";
  }

  /** 把预测失败提示给用户：本地化、去掉 API Key、截断，同一条消息 60 秒内只提示一次 */
  reportRequestError(err: unknown) {
    const t = this.i18n as Record<string, string>;
    const fill = (tpl: string, params: Record<string, string | number>) =>
      tpl.replace(/\{(\w+)\}/g, (m, k: string) => k in params ? String(params[k]) : m);
    let msg: string;
    if (err instanceof GhostWriterError) msg = fill(t[err.key] || err.key, err.params);
    else if ((err as any)?.name === "TimeoutError") msg = fill(t.errTimeout, { seconds: REQUEST_TIMEOUT_MS / 1000 });
    else msg = fill(t.errRequest, { detail: String((err as any)?.message ?? err) });
    msg = msg.replace(/\s+/g, " ").trim();
    const key = this.config.apiKey;
    if (key) msg = msg.split(key).join("***");
    if (msg.length > ERROR_MAX_CHARS) msg = msg.slice(0, ERROR_MAX_CHARS) + "…";

    const now = Date.now();
    this.errorShownAt.forEach((at, m) => { if (now - at >= ERROR_REPEAT_MS) this.errorShownAt.delete(m); });
    if (this.errorShownAt.has(msg)) return;
    this.errorShownAt.set(msg, now);
    const escaped = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    showMessage(escaped, 6000, "error");
  }

  onLayoutReady() {
    getAllEditor().forEach((e) => this.attach(e.protyle));
  }

  // ---------- 按文档开关 ----------

  isDocEnabled(rootID?: string): boolean {
    return !!rootID && this.enabledDocs.has(rootID);
  }

  private toggleDoc(protyle: IProtyle) {
    const rootID = protyle?.block?.rootID;
    if (!rootID) return;
    const on = !this.enabledDocs.has(rootID);
    if (on) this.enabledDocs.add(rootID); else this.enabledDocs.delete(rootID);
    this.saveData(DOCS_STORAGE, { enabled: [...this.enabledDocs] });
    this.refreshButtons();
    if (!on) this.writers.forEach((w) => { if (w.protyle.block.rootID === rootID) w.hide(); });
    const t = this.i18n as Record<string, string>;
    showMessage(on ? t.docOn : t.docOff, 3000);
  }

  /** 把每个编辑器面包屑上的按钮同步为其文档的开关状态 */
  private refreshButtons() {
    this.writers.forEach((w) => this.refreshButton(w.protyle));
  }

  /** 把一个编辑器面包屑上的按钮同步为其文档的开关状态；按钮尚未渲染时什么也不做 */
  refreshButton(protyle: IProtyle) {
    const t = this.i18n as Record<string, string>;
    // 按钮带有 data-plugin-name；data-id 在 3.8.x 中是 "<插件名>:<addBreadcrumbButton 返回的 id>"
    const btn = Array.from(protyle.element.querySelectorAll<HTMLElement>(
      `[data-plugin-name="${CSS.escape(this.name)}"][data-id]`))
      .find((el) => el.dataset.id === this.breadcrumbId || el.dataset.id!.endsWith(":" + this.breadcrumbId));
    if (!btn) return;
    const on = this.isDocEnabled(protyle.block?.rootID);
    btn.classList.toggle("gw-doc-toggle--on", on);
    btn.setAttribute("aria-label", on ? t.docToggleOn : t.docToggleOff);
  }

  private onTitleMenu = ({ detail }: CustomEvent<{ menu: any; protyle: IProtyle }>) => {
    const t = this.i18n as Record<string, string>;
    const on = this.isDocEnabled(detail.protyle?.block?.rootID);
    detail.menu.addItem({
      icon: ICON_ID,
      label: on ? t.docToggleOn : t.docToggleOff,
      click: () => this.toggleDoc(detail.protyle),
    });
  };

  onunload() {
    this.eventBus.off("loaded-protyle-static", this.onLoaded);
    this.eventBus.off("loaded-protyle-dynamic", this.onLoaded);
    this.eventBus.off("switch-protyle", this.onSwitch);
    this.eventBus.off("destroy-protyle", this.onDestroy);
    this.eventBus.off("click-editortitleicon", this.onTitleMenu);
    this.writers.forEach((w) => w.destroy());
    this.writers.clear();
  }

  private onLoaded = ({ detail }: CustomEvent<{ protyle: IProtyle }>) => this.attach(detail.protyle);
  /** 切换编辑器或页签时收起所有建议，再为当前编辑器挂载 */
  private onSwitch = ({ detail }: CustomEvent<{ protyle: IProtyle }>) => {
    this.writers.forEach((w) => w.hide());
    this.attach(detail.protyle);
  };
  private onDestroy = ({ detail }: CustomEvent<{ protyle: IProtyle }>) => {
    const w = this.writers.get(detail.protyle.element);
    if (w) { w.destroy(); this.writers.delete(detail.protyle.element); }
  };

  private attach(protyle: IProtyle) {
    if (!protyle?.wysiwyg?.element) return;
    if (!this.writers.has(protyle.element)) {
      this.writers.set(protyle.element, new GhostWriter(protyle, this));
    }
    // 同一个编辑器可能切换到别的文档，每次加载都刷新按钮状态。不用 requestAnimationFrame：
    // 窗口不可见时它不会触发；按钮还没渲染时由 GhostWriter 的 breadcrumbObserver 补上
    this.refreshButton(protyle);
  }

  // ---------- 设置面板 ----------

  private initSetting() {
    const inputs: Partial<Record<keyof GWConfig, HTMLInputElement | HTMLTextAreaElement>> = {};
    const text = (key: keyof GWConfig, type = "text") => {
      const el = document.createElement("input");
      el.className = "b3-text-field fn__flex-center fn__size200";
      el.type = type;
      el.value = String(this.config[key]);
      inputs[key] = el;
      return el;
    };
    const check = (key: keyof GWConfig) => {
      const el = document.createElement("input");
      el.className = "b3-switch fn__flex-center";
      el.type = "checkbox";
      el.checked = Boolean(this.config[key]);
      inputs[key] = el;
      return el;
    };

    this.setting = new Setting({
      confirmCallback: () => {
        const t = this.i18n as Record<string, string>;
        /** 空值用默认值，非有限数用默认值，其余夹在 [min, max] */
        const num = (key: "delay" | "contextChars" | "temperature", min: number, max: number) => {
          const raw = inputs[key]!.value.trim();
          const n = Number(raw);
          return raw && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULT_CONFIG[key];
        };
        this.config.enabled = (inputs.enabled as HTMLInputElement).checked;
        const baseURL = normalizeBaseURL(inputs.baseURL!.value);
        if (baseURL) this.config.baseURL = baseURL;
        else showMessage(t.errBaseURL, 5000, "error");
        this.config.apiKey = inputs.apiKey!.value.trim();
        this.config.model = inputs.model!.value.trim();
        this.config.delay = Math.round(num("delay", 100, 60000));
        this.config.contextChars = Math.round(num("contextChars", 200, 1000000));
        this.config.temperature = num("temperature", 0, 2);
        this.config.triggerChars = inputs.triggerChars!.value || DEFAULT_CONFIG.triggerChars;
        this.config.useProxy = (inputs.useProxy as HTMLInputElement).checked;
        const system = inputs.systemPrompt!.value.trim();
        this.config.systemPrompt = system === DEFAULT_SYSTEM_PROMPT ? "" : system;
        const template = inputs.userTemplate!.value.trim();
        this.config.userTemplate = template === DEFAULT_USER_TEMPLATE ? "" : template;
        const extra = inputs.extraBody!.value.trim();
        try { parseExtraBody(extra); this.config.extraBody = extra; }
        catch { showMessage(t.errExtraBody, 5000, "error"); }
        this.saveData(STORAGE, this.config);
        this.hideAllIfDisabled();
      },
    });
    const t = this.i18n as Record<string, string>;
    this.setting.addItem({ title: t.enabled, createActionElement: () => check("enabled") });
    this.setting.addItem({ title: t.baseURL, createActionElement: () => text("baseURL") });
    this.setting.addItem({ title: t.apiKey, createActionElement: () => text("apiKey", "password") });
    this.setting.addItem({ title: t.model, createActionElement: () => text("model") });
    this.setting.addItem({ title: t.delay, createActionElement: () => text("delay", "number") });
    this.setting.addItem({ title: t.contextChars, createActionElement: () => text("contextChars", "number") });
    this.setting.addItem({ title: t.triggerChars, createActionElement: () => text("triggerChars") });
    this.setting.addItem({ title: t.useProxy, createActionElement: () => check("useProxy") });
    this.setting.addItem({ title: t.extraBody, description: t.extraBodyDesc, createActionElement: () => text("extraBody") });
    this.setting.addItem({ title: t.temperature, createActionElement: () => {
      const el = text("temperature", "number") as HTMLInputElement;
      el.step = "0.1"; el.min = "0"; el.max = "2";
      return el;
    } });

    const promptEditor = (key: "systemPrompt" | "userTemplate", rows: number) => {
      const wrap = document.createElement("div");
      wrap.className = "fn__flex-1";
      const area = document.createElement("textarea");
      area.className = "b3-text-field fn__block";
      area.rows = rows;
      area.spellcheck = false;
      area.style.resize = "vertical";
      area.style.fontFamily = "var(--b3-font-family-code)";
      area.value = this.config[key] || (key === "systemPrompt" ? DEFAULT_SYSTEM_PROMPT : DEFAULT_USER_TEMPLATE);
      inputs[key] = area;
      const reset = document.createElement("button");
      reset.className = "b3-button b3-button--outline";
      reset.style.marginTop = "6px";
      reset.textContent = t.resetDefault;
      reset.addEventListener("click", () => {
        area.value = key === "systemPrompt" ? DEFAULT_SYSTEM_PROMPT : DEFAULT_USER_TEMPLATE;
      });
      wrap.append(area, reset);
      return wrap;
    };
    this.setting.addItem({ title: t.systemPrompt, description: t.systemPromptDesc, direction: "row", createActionElement: () => promptEditor("systemPrompt", 7) });
    this.setting.addItem({ title: t.userTemplate, description: t.userTemplateDesc, direction: "row", createActionElement: () => promptEditor("userTemplate", 6) });
  }
}

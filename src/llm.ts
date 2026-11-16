import { fetchSyncPost } from "siyuan";
import type { GWConfig } from "./index";

/** 写作模式：在块尾续写下一句，只读上文；改稿模式：在光标处插入一句，读取前后文 */
export type GWMode = "write" | "revise";

/**
 * 实际发送的接口格式：OpenAI 兼容（POST {base}/chat/completions，Authorization: Bearer），
 * 或 Google Gemini 原生（POST {base}/models/{model}:generateContent，x-goog-api-key）
 */
export type WireFormat = "openai" | "gemini";
/** 设置里的接口格式：auto 先探测 Gemini 原生，不支持时回退到 OpenAI 兼容（见 predictNextSentence） */
export type APIFormat = "auto" | WireFormat;
export const API_FORMATS: APIFormat[] = ["auto", "gemini", "openai"];
export const DEFAULT_BASE_URLS: Record<APIFormat, string> = {
  auto: "https://api.deepseek.com",
  openai: "https://api.deepseek.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};
/**
 * 各格式的默认额外请求参数：OpenAI 兼容默认给 DeepSeek 关闭思考；Gemini 的思考参数因模型而异，默认留空。
 * 额外参数按格式过滤（filterExtraBody），所以 auto 沿用 OpenAI 兼容的默认值也不会影响 Gemini 请求
 */
export const DEFAULT_EXTRA_BODIES: Record<APIFormat, string> = {
  auto: '{"thinking":{"type":"disabled"}}',
  openai: '{"thinking":{"type":"disabled"}}',
  gemini: "",
};
/** GenerateContentRequest 里可以由额外参数设置的顶层字段；只属于 Gemini 的字段不会发给 OpenAI 兼容接口 */
const GEMINI_EXTRA_KEYS = new Set(["generationConfig", "safetySettings", "toolConfig", "cachedContent", "serviceTier", "labels"]);
/** OpenAI 兼容接口的默认输出上限（一句话足够） */
export const OPENAI_MAX_TOKENS = 80;
/**
 * Gemini 原生接口的默认输出上限。Gemini 3 及以后无法完全关闭思考，而 maxOutputTokens 包含思考 token，
 * 仍用 80 会只剩思考、没有正文；提示词只要一句话，clean() 也只取第一行
 */
export const GEMINI_MAX_OUTPUT_TOKENS = 1024;

export const DEFAULT_SYSTEM_PROMPT = [
  "你是写作续写助手。根据给定上下文，预测作者接下来最可能写的下一句话。",
  "要求：只输出这一句话本身，不要解释、不要引号、不要重复已有文字、不要换行；",
  "保持与上文一致的语言、人称、语气与排版风格；长度不超过 50 个字；",
  "如果上文明显已经结束（如结论句），输出一句自然的承接句。",
].join("\n");

export const DEFAULT_USER_TEMPLATE = [
  "【文档标题】{{title}}",
  "【上文】",
  "{{before}}",
  "",
  "【当前段落，光标在末尾】",
  "{{current}}",
].join("\n");

export const DEFAULT_REVISE_SYSTEM_PROMPT = [
  "你是改稿助手。作者正在修改一篇已有文稿，光标位于插入点 ▍ 处。请结合插入点前后的内容，写出最适合插入在该处的一句话。",
  "要求：只输出要插入的这一句话本身，不要解释、不要引号、不要换行，不要重复插入点前后已有的文字；",
  "插入后要与前文自然衔接、与后文逻辑连贯，可以补充过渡、论据、细节或例子，不要提前说出后文已经写到的内容；",
  "保持与全文一致的语言、人称、语气与排版风格；长度不超过 50 个字。",
].join("\n");

export const DEFAULT_REVISE_USER_TEMPLATE = [
  "【文档标题】{{title}}",
  "【前文】",
  "{{before}}",
  "",
  "【当前段落，▍为插入点】",
  "{{current}}▍{{currentAfter}}",
  "",
  "【后文】",
  "{{after}}",
].join("\n");

export const DEFAULT_SYSTEM_PROMPT_EN = [
  "You are a writing assistant that continues the author's text. Based on the context, predict the single most likely next sentence the author will write.",
  "Rules: output only that sentence — no explanations, no quotes, no line breaks, and do not repeat existing text;",
  "match the language, person, tone and formatting of the preceding text; keep it under about 30 words;",
  "if the preceding text clearly concludes, write a natural follow-on sentence.",
].join("\n");

export const DEFAULT_USER_TEMPLATE_EN = [
  "[Document title] {{title}}",
  "[Preceding text]",
  "{{before}}",
  "",
  "[Current paragraph, caret at the end]",
  "{{current}}",
].join("\n");

export const DEFAULT_REVISE_SYSTEM_PROMPT_EN = [
  "You are a revision assistant. The author is editing an existing draft, and the caret is at the insertion point ▍. Using the text before and after the insertion point, write the one sentence that best fits there.",
  "Rules: output only the sentence to insert — no explanations, no quotes, no line breaks, and do not repeat text that already exists before or after the insertion point;",
  "it must connect naturally with the preceding text and flow logically into the following text; you may add a transition, argument, detail or example, but do not anticipate content the following text already covers;",
  "match the language, person, tone and formatting of the document; keep it under about 30 words.",
].join("\n");

export const DEFAULT_REVISE_USER_TEMPLATE_EN = [
  "[Document title] {{title}}",
  "[Preceding text]",
  "{{before}}",
  "",
  "[Current paragraph, ▍ marks the insertion point]",
  "{{current}}▍{{currentAfter}}",
  "",
  "[Following text]",
  "{{after}}",
].join("\n");

/** 默认提示词的语言：由思源界面语言决定（zh_* 用中文，其余用英文） */
export type PromptLang = "zh" | "en";

export function promptLangFor(siyuanLang: string | undefined): PromptLang {
  return /^zh/i.test(siyuanLang || "") ? "zh" : "en";
}

/** 可编辑的四个提示词字段 */
export type PromptKey = "systemPrompt" | "userTemplate" | "reviseSystemPrompt" | "reviseUserTemplate";
export const PROMPT_KEYS: PromptKey[] = ["systemPrompt", "userTemplate", "reviseSystemPrompt", "reviseUserTemplate"];

const DEFAULT_PROMPTS: Record<PromptLang, Record<PromptKey, string>> = {
  zh: {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userTemplate: DEFAULT_USER_TEMPLATE,
    reviseSystemPrompt: DEFAULT_REVISE_SYSTEM_PROMPT,
    reviseUserTemplate: DEFAULT_REVISE_USER_TEMPLATE,
  },
  en: {
    systemPrompt: DEFAULT_SYSTEM_PROMPT_EN,
    userTemplate: DEFAULT_USER_TEMPLATE_EN,
    reviseSystemPrompt: DEFAULT_REVISE_SYSTEM_PROMPT_EN,
    reviseUserTemplate: DEFAULT_REVISE_USER_TEMPLATE_EN,
  },
};

export function defaultPrompt(key: PromptKey, lang: PromptLang): string {
  return DEFAULT_PROMPTS[lang][key];
}

/** 与任一语言的默认值相同：保存为空串，以后随界面语言与内置默认值更新 */
export function isDefaultPrompt(key: PromptKey, value: string): boolean {
  const v = value.trim();
  return !v || v === DEFAULT_PROMPTS.zh[key] || v === DEFAULT_PROMPTS.en[key];
}

/** 直连请求的超时，与内核 forwardProxy 的 timeout 一致 */
export const REQUEST_TIMEOUT_MS = 15000;

export interface LLMRequest {
  mode: GWMode;
  /** 默认提示词的语言；用户自定义的提示词不受影响。缺省为中文 */
  lang?: PromptLang;
  title: string;
  before: string;        // 当前块之前的上下文
  current: string;       // 当前块光标前文本
  currentAfter: string;  // 当前块光标后文本（写作模式恒为空）
  after: string;         // 当前块之后的上下文（仅改稿模式）
  signal: AbortSignal;
  /** 作者在同一插入点上已否决的候选（手机端「换一句」），附在用户消息末尾，并稍微提高温度 */
  avoid?: string[];
  /** auto 格式的探测结果缓存；缺省时用模块内的内存缓存 */
  endpointCache?: EndpointCache;
}

/** 「换一句」时在配置温度上增加的量（上限 2）；extraBody 里的 temperature 仍然优先 */
export const REGENERATE_TEMPERATURE_BOOST = 0.3;

/** 附在用户消息末尾的「已否决候选」说明；没有候选时为空串。与用户自定义的模板无关，始终生效 */
export function avoidNote(avoid: string[] | undefined, lang: PromptLang = "zh"): string {
  const list = (avoid || []).map((s) => s.trim()).filter(Boolean);
  if (!list.length) return "";
  const head = lang === "en"
    ? "[Rejected candidates] The author rejected the following sentences. Write one that is clearly different in wording or content:"
    : "【作者已否决的候选】以下句子作者不满意，请给出说法或内容明显不同的一句：";
  return [head, ...list.map((s) => "- " + s)].join("\n");
}

type TemplateVars = Pick<LLMRequest, "title" | "before" | "current"> & Partial<Pick<LLMRequest, "currentAfter" | "after">>;

/**
 * 面向用户的预测失败。key 对应 i18n 里的文案，params 填充文案中的 {name} 占位符。
 * 消息由 GhostWriterPlugin.reportRequestError 统一本地化、截断、去重后提示。
 */
export class GhostWriterError extends Error {
  constructor(public readonly key: string, public readonly params: Record<string, string | number> = {}) {
    super(`${key} ${JSON.stringify(params)}`);
    this.name = "GhostWriterError";
  }
}

const VAR = (name: string) => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`);
const ANY_VAR = /\{\{\s*(title|before|currentAfter|current|after)\s*\}\}/g;

/**
 * 渲染用户消息模板。变量：{{title}} {{before}} {{current}} {{currentAfter}} {{after}}
 * - 兼容全角花括号 ｛｛ ｝｝
 * - 标题为空时，删除只含 {{title}} 这一个变量的行；同一行还有其它变量时只把 {{title}} 替换为空
 * - 模板没引用 {{current}} 时，把当前段落附在末尾，避免误删变量后丢失上下文
 * - 所有变量一次替换完成：正文里出现的 {{current}} 等字样、`$&`、`$1` 都按原文保留
 */
export function renderTemplate(tpl: string, req: TemplateVars): string {
  let out = tpl.replace(/｛｛/g, "{{").replace(/｝｝/g, "}}");

  if (!req.title.trim()) {
    out = out.split("\n")
      .filter((line) => !VAR("title").test(line) || (line.match(ANY_VAR) || []).length > 1)
      .join("\n");
  }
  const hasCurrent = VAR("current").test(out);
  const values: Record<string, string> = {
    title: req.title, before: req.before, current: req.current,
    currentAfter: req.currentAfter ?? "", after: req.after ?? "",
  };
  out = out.replace(ANY_VAR, (_, name: string) => values[name]);
  if (!hasCurrent) out += "\n\n" + req.current;
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** 按模式取提示词；配置为空串时用该模式的默认值 */
export function promptsFor(cfg: GWConfig, mode: GWMode, lang: PromptLang = "zh") {
  // 空串或与任一语言默认值相同：用当前界面语言的默认值；否则用用户的自定义内容
  const pick = (key: PromptKey) => {
    const v = (cfg[key] || "").trim();
    return isDefaultPrompt(key, v) ? defaultPrompt(key, lang) : v;
  };
  return mode === "revise"
    ? { system: pick("reviseSystemPrompt"), template: pick("reviseUserTemplate") }
    : { system: pick("systemPrompt"), template: pick("userTemplate") };
}

export function buildMessages(cfg: GWConfig, req: LLMRequest) {
  const lang = req.lang ?? "zh";
  const { system, template: tpl } = promptsFor(cfg, req.mode, lang);
  const note = avoidNote(req.avoid, lang);
  return [
    { role: "system", content: system },
    { role: "user", content: renderTemplate(tpl, req) + (note ? "\n\n" + note : "") },
  ];
}

/** 解析“额外请求参数”：空串为 {}；必须是 JSON 对象（不能是数组或标量） */
export function parseExtraBody(extraBody: string): Record<string, unknown> {
  const s = (extraBody || "").trim();
  if (!s) return {};
  let v: unknown;
  try { v = JSON.parse(s); } catch { throw new GhostWriterError("errExtraBody"); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new GhostWriterError("errExtraBody");
  return v as Record<string, unknown>;
}

/**
 * 规范化 API 地址：必须是 http(s) URL，去掉末尾的 /，以及误粘贴的 /chat/completions 或
 * /models/<模型>:generateContent；无效时返回 null
 */
export function normalizeBaseURL(baseURL: string): string | null {
  const s = (baseURL || "").trim().replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/models\/[^/\s]+:(stream)?generateContent$/i, "")
    .replace(/\/+$/, "");
  return /^https?:\/\/[^/\s]+/i.test(s) ? s : null;
}

/** 设置里的接口格式；缺省或无效时为 auto */
export function apiFormatOf(cfg: Partial<Pick<GWConfig, "apiFormat">>): APIFormat {
  return API_FORMATS.includes(cfg.apiFormat as APIFormat) ? cfg.apiFormat as APIFormat : "auto";
}

/**
 * auto 模式下要探测的 Gemini 原生地址（按顺序）。用户通常填的是 OpenAI 兼容地址，而同一服务的
 * Gemini 原生地址一般在：去掉 /openai（Google AI Studio）、/v1 换成 /v1beta（new-api 等中转）、
 * 没有版本段时加 /v1beta。最后才是原地址本身。
 */
export function geminiBaseCandidates(base: string): string[] {
  const out: string[] = [];
  const add = (u: string) => { if (!out.includes(u)) out.push(u); };
  if (/\/openai$/i.test(base)) add(base.replace(/\/openai$/i, ""));
  if (/\/v1$/i.test(base)) add(base.replace(/\/v1$/i, "/v1beta"));
  if (!/\/v\d+(alpha|beta)?\d*(\/|$)/i.test(new URL(base).pathname)) add(base + "/v1beta");
  add(base);
  return out;
}

/** 请求地址与鉴权头。Gemini 的 Key 放在 x-goog-api-key 头里，不放进 URL，避免出现在日志和错误信息中 */
export function endpointFor(cfg: GWConfig, base: string, wire: WireFormat): { url: string; headers: Record<string, string> } {
  if (wire === "gemini") {
    // 允许填写 "models/gemini-x"，与 Gemini 返回的模型名一致
    const model = (cfg.model || "").trim().replace(/^models\//, "");
    return {
      url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
      headers: { "x-goog-api-key": cfg.apiKey },
    };
  }
  return { url: base + "/chat/completions", headers: { Authorization: `Bearer ${cfg.apiKey}` } };
}

/** 「换一句」时把温度提高一点（保留两位小数，上限 2） */
function requestTemperature(cfg: GWConfig, req: LLMRequest): number {
  const base = cfg.temperature ?? 0.7;
  return req.avoid?.length ? Math.min(2, Math.round((base + REGENERATE_TEMPERATURE_BOOST) * 100) / 100) : base;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 递归合并普通对象，extra 优先；数组和标量整体覆盖 */
export function deepMerge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

/**
 * 额外请求参数按格式取各自的字段：Gemini 只取 GenerateContentRequest 的顶层字段（generationConfig 等），
 * OpenAI 兼容丢掉这些字段。这样同一份设置可以同时写两种格式的参数，auto 探测时也不会因为对方不认识的字段而报错
 */
export function filterExtraBody(extra: Record<string, unknown>, wire: WireFormat): Record<string, unknown> {
  return Object.fromEntries(Object.entries(extra).filter(([k]) => GEMINI_EXTRA_KEYS.has(k) === (wire === "gemini")));
}

/** OpenAI 兼容请求体：extraBody 可覆盖 temperature、max_tokens 等，但不能覆盖 model、messages、stream */
export function buildRequestBody(cfg: GWConfig, req: LLMRequest) {
  return {
    temperature: requestTemperature(cfg, req),
    max_tokens: OPENAI_MAX_TOKENS,
    ...filterExtraBody(parseExtraBody(cfg.extraBody), "openai"),
    model: cfg.model,
    messages: buildMessages(cfg, req),
    stream: false,
  };
}

/**
 * Gemini generateContent 请求体。extraBody 按对象递归合并，可以只覆盖 generationConfig 里的部分字段
 * （如 thinkingConfig、maxOutputTokens）而保留温度；但不能覆盖 systemInstruction 与 contents
 */
export function buildGeminiRequestBody(cfg: GWConfig, req: LLMRequest) {
  const [system, user] = buildMessages(cfg, req);
  const extra = parseExtraBody(cfg.extraBody);
  const merged = deepMerge({
    generationConfig: { temperature: requestTemperature(cfg, req), maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
  }, filterExtraBody(extra, "gemini"));
  // 沿用为 OpenAI 兼容接口写的参数（与 Google 自己的 OpenAI 兼容层一致），但 generationConfig 里显式设置的优先：
  // reasoning_effort → thinkingConfig（否则按模型默认的较高思考等级运行，实测慢数倍）；
  // max_tokens / max_completion_tokens → maxOutputTokens（两者都包含思考 token）
  const gen = merged.generationConfig as Record<string, unknown>;
  const own = isPlainObject(extra.generationConfig) ? extra.generationConfig : {};
  if (isPlainObject(gen)) {
    if (own.thinkingConfig === undefined) {
      const thinking = thinkingFromEffort(extra.reasoning_effort, cfg.model);
      if (thinking) gen.thinkingConfig = thinking;
    }
    const maxTokens = extra.max_completion_tokens ?? extra.max_tokens;
    if (own.maxOutputTokens === undefined && typeof maxTokens === "number" && maxTokens > 0) gen.maxOutputTokens = maxTokens;
  }
  return {
    ...merged,
    systemInstruction: { parts: [{ text: system.content }] },
    contents: [{ role: "user", parts: [{ text: user.content }] }],
  };
}

/**
 * 把 OpenAI 的 reasoning_effort 换算成 Gemini 的 thinkingConfig：2.5 系列用 thinkingBudget（按官方对照表），
 * 其它模型用 thinkingLevel。none / minimal 换成 low：不是每个模型都支持 minimal，3.x 与 4.x 都不能关闭思考。
 * 不认识的值返回 undefined（不设置）
 */
export function thinkingFromEffort(effort: unknown, model: string): Record<string, unknown> | undefined {
  if (typeof effort !== "string") return undefined;
  const e = effort.trim().toLowerCase();
  if (/(^|\/)gemini-2\.5/i.test((model || "").trim())) {
    const budgets: Record<string, number> = { none: 0, minimal: 1024, low: 1024, medium: 8192, high: 24576 };
    return e in budgets ? { thinkingBudget: budgets[e] } : undefined;
  }
  const levels: Record<string, string> = { none: "low", minimal: "low", low: "low", medium: "medium", high: "high" };
  return e in levels ? { thinkingLevel: levels[e] } : undefined;
}

/** Gemini 因安全、引用等原因中止生成的 finishReason：没有正文时提示「被拦截」 */
const GEMINI_BLOCKED_FINISH = new Set([
  "SAFETY", "RECITATION", "LANGUAGE", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
]);

/** 取 Gemini 响应的正文：跳过 thought: true 的思考摘要 */
export function geminiResult(data: any) {
  const cand = data?.candidates?.[0];
  const parts: any[] = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
  return {
    text: parts.filter((p) => !p?.thought && typeof p?.text === "string").map((p) => p.text).join(""),
    thought: parts.some((p) => p?.thought) || (data?.usageMetadata?.thoughtsTokenCount ?? 0) > 0,
    finishReason: typeof cand?.finishReason === "string" ? cand.finishReason : "",
    blockReason: typeof data?.promptFeedback?.blockReason === "string" ? data.promptFeedback.blockReason : "",
  };
}

/** OpenAI 兼容的 content 可能是字符串、null，或 [{type:"text",text:"…"}] 数组 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part
      : typeof part?.text === "string" ? part.text : "").join("");
  }
  return "";
}

const QUOTE_PAIRS: Record<string, string> = {
  '"': '"', "'": "'", "“": "”", "‘": "’", "「": "」", "『": "』",
};

/**
 * 把模型输出整理成一句可直接插在 current 与 currentAfter 之间的文字；不可用时返回 ""。
 * currentAfter 只在改稿模式、光标在段中时非空。
 */
export function clean(raw: string, current: string, currentAfter = ""): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (t.includes("<think>")) return ""; // 思考没结束就被截断了，没有正文
  t = t.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";

  // 只去掉成对包住整句的引号，保留句中或句尾正常使用的引号
  const close = QUOTE_PAIRS[t[0]];
  if (t.length >= 2 && close && t.endsWith(close)) {
    const inner = t.slice(1, -1);
    if (!inner.includes(t[0]) && !inner.includes(close)) t = inner.trim();
  }

  // 模型有时会把当前段落的结尾重复一遍再续写：去掉“输出前缀 == 段落后缀”的最长部分
  const cur = current.trimEnd();
  for (let k = Math.min(cur.length, t.length); k >= 4; k--) {
    if (cur.endsWith(t.slice(0, k))) { t = t.slice(k).trimStart(); break; }
  }

  // 改稿模式：模型有时会把插入点后的开头也写出来：去掉“输出后缀 == 后文前缀”的最长部分
  const nextText = currentAfter.trimStart();
  for (let k = Math.min(nextText.length, t.length); k >= 4; k--) {
    if (nextText.startsWith(t.slice(-k))) { t = t.slice(0, -k).trimEnd(); break; }
  }

  // 英文句子：段落以 ASCII 标点结尾且后面没有空格时补一个空格，避免 "world.Next"
  if (t && /[!-/:-@[-`{-~]$/.test(current) && /^[A-Za-z0-9"'(]/.test(t)) t = " " + t;
  // 插在英文后文之前：后文紧接字母数字时在句尾补空格，避免 "Next.Following"
  if (t && /^[A-Za-z0-9"'(]/.test(currentAfter) && /[!-~]$/.test(t)) t = t + " ";
  return t;
}

/** 合并调用方的取消信号和超时；运行环境没有 AbortSignal.any 时手动合并 */
function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  if (typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), ms);
  const onAbort = () => { clearTimeout(timer); ctrl.abort(signal.reason); };
  if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}

function parseJSON(text: string): any {
  try { return JSON.parse(text); }
  catch { throw new GhostWriterError("errBadResponse", { detail: text }); }
}

/** auto 模式探测出的接口：格式与实际使用的地址 */
export interface ResolvedEndpoint {
  format: WireFormat;
  base: string;
}

/** 探测结果缓存，键为 endpointSignature()。插件传入会持久化的实现，未传时用内存里的 Map */
export interface EndpointCache {
  get(sig: string): ResolvedEndpoint | undefined;
  set(sig: string, value: ResolvedEndpoint): void;
  delete(sig: string): void;
}
const memoryEndpointCache: EndpointCache = new Map<string, ResolvedEndpoint>();

/**
 * auto 模式只对 Google 的模型（名称含 gemini / gemma）探测 Gemini 原生格式。new-api 等中转会把 Gemini 格式的请求
 * 转成其它模型（如 GPT）的请求，但实测会丢掉 systemInstruction，建议质量明显变差，所以其它模型直接用 OpenAI 兼容。
 */
export function prefersGemini(model: string): boolean {
  return /gemini|gemma/i.test(model || "");
}

/** 同一地址和模型只探测一次；换地址或模型后重新探测 */
export function endpointSignature(base: string, model: string): string {
  return `${base}|${(model || "").trim()}`;
}

/** Google 风格的错误体 {"error":{"code":400,"message":"…","status":"INVALID_ARGUMENT"}}；也兼容外层包一层数组 */
function isGoogleStyleError(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  try {
    let d = JSON.parse(detail);
    if (Array.isArray(d)) d = d[0];
    return typeof d?.error?.status === "string" && /^[A-Z_]+$/.test(d.error.status);
  } catch {
    return false;
  }
}

/**
 * 探测时遇到这个错误能否换下一种地址 / 格式再试：HTTP 错误、响应不是 JSON 或不是该格式的响应、
 * 直连时的网络 / CORS 错误（TypeError）可以；超时、取消、内核转发失败不重试（换地址也不会好，只会更慢）；
 * 模型已经应答但没有正文或被拦截时也不重试。
 * 注意：Google 风格的 400 也要继续试，new-api 等中转对 Gemini 路由上不存在的模型会这样报错。
 */
export function canTryNext(err: unknown): boolean {
  const name = (err as any)?.name;
  if (name === "AbortError" || name === "TimeoutError") return false;
  if (err instanceof TypeError) return true;
  return err instanceof GhostWriterError && (err.key === "errHTTP" || err.key === "errBadResponse");
}

/**
 * 「这个地址不支持该格式」的弱失败：404/405、非 Google 风格的错误体、响应不是 JSON 或不是该格式、网络 / CORS 错误。
 * 用于：缓存的接口只在弱失败时失效（临时的 429 / 500 不会把格式切走）；两种格式都失败时挑更有信息量的错误。
 */
export function isWeakFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (!(err instanceof GhostWriterError)) return false;
  if (err.key === "errBadResponse") return true;
  if (err.key !== "errHTTP") return false;
  const status = Number(err.params.status);
  return status === 404 || status === 405 || !isGoogleStyleError(err.params.detail);
}

/**
 * 预测下一句。接口格式为 gemini / openai 时直接按该格式请求填写的地址。
 * auto（默认）：Gemini / Gemma 模型先按 geminiBaseCandidates() 依次探测 Gemini 原生接口，都不行时回退到
 * OpenAI 兼容；其它模型直接用 OpenAI 兼容（见 prefersGemini）。
 * 成功的结果按地址 + 模型缓存，之后直接使用；缓存的接口出现弱失败（isWeakFailure）时重新探测。
 * 两种格式都失败时报告 OpenAI 兼容请求的错误；但它只是弱失败、而 Gemini 给出了有意义的错误（如 Key 无效）时，
 * 报告 Gemini 的错误，避免真正的原因被一个 404 掩盖。
 */
export async function predictNextSentence(cfg: GWConfig, req: LLMRequest): Promise<string> {
  const base = normalizeBaseURL(cfg.baseURL);
  if (!base) throw new GhostWriterError("errBaseURL");
  const setting = apiFormatOf(cfg);
  if (setting !== "auto") return callOnce(cfg, req, setting, base);
  if (!prefersGemini(cfg.model)) return callOnce(cfg, req, "openai", base);

  const cache = req.endpointCache ?? memoryEndpointCache;
  const sig = endpointSignature(base, cfg.model);
  const known = cache.get(sig);
  if (known) {
    try {
      return await callOnce(cfg, req, known.format, known.base);
    } catch (err) {
      if (!isWeakFailure(err)) throw err;
      cache.delete(sig);
    }
  }
  let geminiError: unknown;
  for (const geminiBase of geminiBaseCandidates(base)) {
    if (known?.format === "gemini" && known.base === geminiBase) continue; // 刚刚已经试过
    try {
      const result = await callOnce(cfg, req, "gemini", geminiBase);
      cache.set(sig, { format: "gemini", base: geminiBase });
      return result;
    } catch (err) {
      if (!canTryNext(err)) throw err;
      if (!isWeakFailure(err)) geminiError ??= err;
    }
  }
  try {
    const result = await callOnce(cfg, req, "openai", base);
    cache.set(sig, { format: "openai", base });
    return result;
  } catch (err) {
    throw geminiError && isWeakFailure(err) ? geminiError : err;
  }
}

/** 按指定格式和地址请求一次，返回整理后的建议文字 */
async function callOnce(cfg: GWConfig, req: LLMRequest, format: WireFormat, base: string): Promise<string> {
  const { url, headers } = endpointFor(cfg, base, format);
  const body = format === "gemini" ? buildGeminiRequestBody(cfg, req) : buildRequestBody(cfg, req);

  let data: any;
  if (cfg.useProxy) {
    // 内核转发：无 CORS 限制，但不支持流式
    const res: any = await fetchSyncPost("/api/network/forwardProxy", {
      url,
      method: "POST",
      timeout: REQUEST_TIMEOUT_MS,
      contentType: "application/json",
      headers: Object.entries(headers).map(([k, v]) => ({ [k]: v })),
      payload: body,
      payloadEncoding: "json",
      responseEncoding: "text",
    }, undefined, undefined, req.signal);
    if (res?.code !== 0) throw new GhostWriterError("errProxy", { code: res?.code ?? "?", detail: res?.msg ?? "" });
    if (res.data.status >= 400) throw new GhostWriterError("errHTTP", { status: res.data.status, detail: res.data.body ?? "" });
    data = parseJSON(res.data.body);
  } else {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: withTimeout(req.signal, REQUEST_TIMEOUT_MS),
    });
    const text = await resp.text();
    if (!resp.ok) throw new GhostWriterError("errHTTP", { status: resp.status, detail: text });
    data = parseJSON(text);
  }

  if (format === "gemini") {
    // 不是 Gemini 响应（例如中转对未知路径返回了别的 JSON）：按响应无效处理，auto 模式会据此回退
    if (!Array.isArray(data?.candidates) && !data?.promptFeedback) {
      throw new GhostWriterError("errBadResponse", { detail: JSON.stringify(data).slice(0, 300) });
    }
    const g = geminiResult(data);
    if (g.blockReason) throw new GhostWriterError("errBlocked", { reason: g.blockReason });
    const result = clean(g.text, req.current, req.currentAfter);
    if (!result) {
      if (GEMINI_BLOCKED_FINISH.has(g.finishReason)) throw new GhostWriterError("errBlocked", { reason: g.finishReason });
      if (g.thought || g.finishReason === "MAX_TOKENS") throw new GhostWriterError("errNoContentGemini");
    }
    return result;
  }

  const choice = data?.choices?.[0];
  const result = clean(contentText(choice?.message?.content), req.current, req.currentAfter);
  if (!result) {
    const reasoning = contentText(choice?.message?.reasoning_content);
    if (reasoning.trim() || choice?.finish_reason === "length") throw new GhostWriterError("errNoContent");
  }
  return result;
}

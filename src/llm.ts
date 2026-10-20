import { fetchSyncPost } from "siyuan";
import type { GWConfig } from "./index";

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

/** 直连请求的超时，与内核 forwardProxy 的 timeout 一致 */
export const REQUEST_TIMEOUT_MS = 15000;

export interface LLMRequest {
  title: string;
  before: string;   // 当前块之前的上下文
  current: string;  // 当前块光标前文本
  signal: AbortSignal;
}

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
const ANY_VAR = /\{\{\s*(title|before|current)\s*\}\}/g;

/**
 * 渲染用户消息模板。变量：{{title}} {{before}} {{current}}
 * - 兼容全角花括号 ｛｛ ｝｝
 * - 标题为空时，删除只含 {{title}} 这一个变量的行；同一行还有其它变量时只把 {{title}} 替换为空
 * - 模板没引用 {{current}} 时，把当前段落附在末尾，避免误删变量后丢失上下文
 * - 所有变量一次替换完成：正文里出现的 {{current}} 等字样、`$&`、`$1` 都按原文保留
 */
export function renderTemplate(tpl: string, req: Pick<LLMRequest, "title" | "before" | "current">): string {
  let out = tpl.replace(/｛｛/g, "{{").replace(/｝｝/g, "}}");

  if (!req.title.trim()) {
    out = out.split("\n")
      .filter((line) => !VAR("title").test(line) || VAR("before").test(line) || VAR("current").test(line))
      .join("\n");
  }
  const hasCurrent = VAR("current").test(out);
  const values: Record<string, string> = { title: req.title, before: req.before, current: req.current };
  out = out.replace(ANY_VAR, (_, name: string) => values[name]);
  if (!hasCurrent) out += "\n\n" + req.current;
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function buildMessages(cfg: GWConfig, req: LLMRequest) {
  const system = (cfg.systemPrompt || "").trim() || DEFAULT_SYSTEM_PROMPT;
  const tpl = (cfg.userTemplate || "").trim() || DEFAULT_USER_TEMPLATE;
  return [
    { role: "system", content: system },
    { role: "user", content: renderTemplate(tpl, req) },
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

/** 规范化 API 地址：必须是 http(s) URL，去掉末尾的 / 和误粘贴的 /chat/completions；无效时返回 null */
export function normalizeBaseURL(baseURL: string): string | null {
  const s = (baseURL || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
  return /^https?:\/\/[^/\s]+/i.test(s) ? s : null;
}

/** 请求体：extraBody 可覆盖 temperature、max_tokens 等，但不能覆盖 model、messages、stream */
export function buildRequestBody(cfg: GWConfig, req: LLMRequest) {
  return {
    temperature: cfg.temperature ?? 0.7,
    max_tokens: 80,
    ...parseExtraBody(cfg.extraBody),
    model: cfg.model,
    messages: buildMessages(cfg, req),
    stream: false,
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

/** 把模型输出整理成一句可直接接在 current 后面的文字；不可用时返回 "" */
export function clean(raw: string, current: string): string {
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

  // 英文句子：段落以 ASCII 标点结尾且后面没有空格时补一个空格，避免 "world.Next"
  if (t && /[!-/:-@[-`{-~]$/.test(current) && /^[A-Za-z0-9"'(]/.test(t)) t = " " + t;
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

export async function predictNextSentence(cfg: GWConfig, req: LLMRequest): Promise<string> {
  const base = normalizeBaseURL(cfg.baseURL);
  if (!base) throw new GhostWriterError("errBaseURL");
  const url = base + "/chat/completions";
  const body = buildRequestBody(cfg, req);

  let data: any;
  if (cfg.useProxy) {
    // 内核转发：无 CORS 限制，但不支持流式
    const res: any = await fetchSyncPost("/api/network/forwardProxy", {
      url,
      method: "POST",
      timeout: REQUEST_TIMEOUT_MS,
      contentType: "application/json",
      headers: [{ Authorization: `Bearer ${cfg.apiKey}` }],
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: withTimeout(req.signal, REQUEST_TIMEOUT_MS),
    });
    const text = await resp.text();
    if (!resp.ok) throw new GhostWriterError("errHTTP", { status: resp.status, detail: text });
    data = parseJSON(text);
  }

  const choice = data?.choices?.[0];
  const result = clean(contentText(choice?.message?.content), req.current);
  if (!result) {
    const reasoning = contentText(choice?.message?.reasoning_content);
    if (reasoning.trim() || choice?.finish_reason === "length") throw new GhostWriterError("errNoContent");
  }
  return result;
}

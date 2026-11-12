import type { IProtyle } from "siyuan";
import type GhostWriterPlugin from "./index";
import { predictNextSentence, type GWMode } from "./llm";
import { MobileBar, bindTap, charIndexAt, clauseEnd } from "./mobile";

/** 「换一句」时最多带上几条已否决的候选 */
const MAX_AVOID = 5;
/** 手机端行内灰字最多显示几行，其余部分截断 */
const MOBILE_MAX_LINES = 3;
/** 手机端灰字字号：屏幕窄，比正文小一些才不显得拥挤；桌面端与正文同字号 */
const MOBILE_GHOST_FONT_PX = 12;
/** 手机端卡片（改稿模式、光标在段中）的行高倍数 */
const MOBILE_CARD_LINE_HEIGHT = 1.5;

interface RequestOptions {
  /** 手动触发（「续写」「换一句」）：不要求光标前以触发标点结尾 */
  manual?: boolean;
  /** 作者已否决的候选，请模型换一种说法 */
  avoid?: string[];
}

const ZW = /[\u200b\u200c\u200d\ufeff]/g;
const SKIP_BLOCK_TYPES = new Set([
  "NodeCodeBlock", "NodeMathBlock", "NodeHTMLBlock", "NodeTable",
  "NodeAttributeView", "NodeIFrame", "NodeWidget", "NodeVideo", "NodeAudio",
]);

interface Anchor {
  node: Node;
  offset: number;
  blockId: string;
}

/**
 * 给会触发思源行内语法的 ASCII 字符加反斜杠（加粗、公式、块引用、标签、HTML、emoji 等），
 * 使模型输出经 Lute 转换后按原文显示和保存。
 */
export function escapeMarkdownInline(text: string): string {
  return text.replace(/[\\`*_~$[\](){}<>&#=^!|]|:(?=[\w+-]+:)/g, (m) => "\\" + m);
}

function plainText(el: Element | null | undefined): string {
  return (el?.textContent || "").replace(ZW, "");
}

/**
 * Lute 把 text 当作 Markdown 渲染后仍是纯文字（没有任何行内元素，文字与原文一致），
 * 就可以不转义直接插入，避免把普通标点存成 \( \! 等反斜杠转义。
 */
export function isPlainTextRender(editable: Pick<Element, "childElementCount" | "textContent">, text: string): boolean {
  return editable.childElementCount === 0 && (editable.textContent || "").replace(ZW, "") === text;
}

/** 光标矩形取不到时（如紧跟在行内公式之后），用块内容最后一行末尾的位置 */
function contentEndRect(editable: HTMLElement): DOMRect | undefined {
  const r = document.createRange();
  r.selectNodeContents(editable);
  let best: DOMRect | undefined;
  for (const x of Array.from(r.getClientRects())) {
    if (!x.width && !x.height) continue;
    if (!best || x.bottom > best.bottom + 1 || (Math.abs(x.bottom - best.bottom) <= 1 && x.right > best.right)) best = x;
  }
  return best && new DOMRect(best.right, best.top, 0, best.height);
}

export class GhostWriter {
  private el: HTMLElement;
  private overlay: HTMLDivElement;
  private timer: number | undefined;
  private seq = 0;
  private abort: AbortController | undefined;
  private suggestion = "";
  private anchor: Anchor | undefined;
  private breadcrumbObserver: MutationObserver | undefined;
  /** 当前建议是否以卡片形式显示在光标所在行的下方（改稿模式、光标在段中） */
  private card = false;
  /** 请求进行中（手机端用操作栏的进度条表示，不在行内显示占位） */
  private loading = false;
  /** 本次插入点上被「换一句」否决的候选 */
  private avoid: string[] = [];
  /** 手机端：键盘上方的操作栏、点按灰字采纳；桌面端两者都没有 */
  private readonly mobile: boolean;
  private bar: MobileBar | undefined;
  private unbindGhostTap: (() => void) | undefined;
  /** 滚动、视口变化时：桌面端收起建议，手机端（键盘弹出、地址栏收起都会触发）重新定位 */
  private readonly reflow: () => void;
  private reflowPending = false;

  constructor(public readonly protyle: IProtyle, private plugin: GhostWriterPlugin) {
    this.el = protyle.wysiwyg!.element;
    this.mobile = plugin.isMobile;
    this.reflow = this.mobile ? this.reposition : this.hide;
    // 插件加载与编辑器创建的先后不定，面包屑按钮可能在挂载之后才由思源插入，插入时再同步开关状态
    const slot = protyle.element.querySelector(".protyle-breadcrumb__plugin");
    if (slot) {
      this.breadcrumbObserver = new MutationObserver(() => plugin.refreshButton(protyle));
      this.breadcrumbObserver.observe(slot, { childList: true });
    }
    this.overlay = document.createElement("div");
    this.overlay.className = "gw-ghost";
    this.overlay.style.display = "none";
    document.body.appendChild(this.overlay);

    if (this.mobile) {
      this.overlay.classList.add("gw-ghost--mobile");
      this.unbindGhostTap = bindTap(this.overlay, this.onGhostTap);
      this.bar = new MobileBar(plugin.barLabels(), {
        accept: () => this.accept(),
        regenerate: () => this.regenerate(),
        dismiss: () => this.cancel(),
        continue: () => this.manualRequest(),
        openMode: (button) => plugin.openModeMenuAt(button, this.protyle),
      });
      this.el.addEventListener("focusin", this.syncBar);
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      window.visualViewport?.addEventListener("resize", this.reflow);
      window.visualViewport?.addEventListener("scroll", this.reflow);
    }

    this.el.addEventListener("input", this.onInput);
    this.el.addEventListener("compositionstart", this.dismiss);
    this.el.addEventListener("compositionend", this.onInput);
    this.el.addEventListener("keydown", this.onKeydown, true);
    this.el.addEventListener("mousedown", this.dismiss);
    this.el.addEventListener("focusout", this.onFocusOut);
    protyle.contentElement?.addEventListener("scroll", this.reflow, { passive: true });
    document.addEventListener("selectionchange", this.onSelectionChange);
    window.addEventListener("resize", this.reflow);
  }

  destroy() {
    this.cancel();
    this.breadcrumbObserver?.disconnect();
    this.el.removeEventListener("input", this.onInput);
    this.el.removeEventListener("compositionstart", this.dismiss);
    this.el.removeEventListener("compositionend", this.onInput);
    this.el.removeEventListener("keydown", this.onKeydown, true);
    this.el.removeEventListener("mousedown", this.dismiss);
    this.el.removeEventListener("focusout", this.onFocusOut);
    this.protyle.contentElement?.removeEventListener("scroll", this.reflow);
    document.removeEventListener("selectionchange", this.onSelectionChange);
    window.removeEventListener("resize", this.reflow);
    if (this.mobile) {
      this.el.removeEventListener("focusin", this.syncBar);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      window.visualViewport?.removeEventListener("resize", this.reflow);
      window.visualViewport?.removeEventListener("scroll", this.reflow);
    }
    this.unbindGhostTap?.();
    this.bar?.destroy();
    this.overlay.remove();
  }

  private get delay(): number {
    return this.mobile ? this.plugin.config.mobileDelay : this.plugin.config.delay;
  }

  // ---------- 事件 ----------

  private onInput = (e: Event) => {
    if ((e as InputEvent).isComposing) return; // 中文输入法组字阶段不触发
    this.cancel();
    this.avoid = [];
    const mode = this.activeMode();
    if (!mode) return;
    const ctx = this.collectContext(mode);
    if (!ctx || !this.endsWithTrigger(ctx.current)) return;
    this.timer = window.setTimeout(() => this.request(), this.delay);
  };

  /** 开始组字、点击编辑器：取消待发请求和已显示的建议 */
  private dismiss = () => this.cancel();

  /** 焦点离开编辑器（切到其它面板、页签等）时收起 */
  private onFocusOut = (e: FocusEvent) => {
    if (e.relatedTarget instanceof Node && this.el.contains(e.relatedTarget)) return;
    this.cancel();
    // focusout 期间 activeElement 可能还没更新，等焦点落定后再决定操作栏是否显示
    if (this.bar) window.setTimeout(this.syncBar);
  };

  /** 手机端切到后台：取消请求，避免在后台继续消耗流量 */
  private onVisibilityChange = () => {
    if (document.hidden) this.cancel();
  };

  private onKeydown = (e: KeyboardEvent) => {
    if (!this.suggestion || e.isComposing) return;
    if (!this.activeMode()) {
      // 已关闭、只读或思源提示菜单打开：不再拦截 Tab / Esc
      this.hide();
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.accept();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
    }
    // 其它按键：由随后的 input / selectionchange 自然关闭
  };

  private onSelectionChange = () => {
    if (!this.anchor) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return this.hide();
    const r = sel.getRangeAt(0);
    if (!r.collapsed || r.startContainer !== this.anchor.node || r.startOffset !== this.anchor.offset) {
      this.hide();
    }
  };

  // ---------- 上下文 ----------

  private endsWithTrigger(current: string): boolean {
    const last = current.trimEnd().slice(-1);
    return !!last && this.plugin.config.triggerChars.includes(last);
  }

  /**
   * 收集光标处的上下文。写作模式只在块尾触发、只读上文；
   * 改稿模式允许光标在段中，并读取光标后的段落剩余部分与后续块。
   */
  private collectContext(mode: GWMode) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const startEl = range.startContainer instanceof Element
      ? range.startContainer : range.startContainer.parentElement;
    if (!startEl || !this.el.contains(startEl)) return null;

    const block = startEl.closest<HTMLElement>("[data-node-id]");
    if (!block) return null;
    const type = block.getAttribute("data-type") || "";
    if (SKIP_BLOCK_TYPES.has(type)
      || block.closest('[data-type="NodeCodeBlock"], [data-type="NodeBlockQueryEmbed"]')) return null;
    const editable = block.querySelector<HTMLElement>(':scope > [contenteditable="true"]');
    if (!editable || !editable.contains(range.startContainer)) return null;

    const r = document.createRange();
    r.setStart(editable, 0);
    r.setEnd(range.startContainer, range.startOffset);
    const current = r.toString().replace(ZW, "");
    r.setStart(range.startContainer, range.startOffset);
    r.setEnd(editable, editable.childNodes.length);
    const rest = r.toString().replace(ZW, "");
    if (mode === "write" && rest.trim()) return null; // 写作模式只在块尾预测
    const currentAfter = rest.trim() ? rest.replace(/\s+$/, "") : "";

    // 前文：文档中当前块之前的所有叶子块文本；后文（仅改稿模式）：当前块之后的叶子块文本
    const editables = Array.from(
      this.el.querySelectorAll<HTMLElement>('[data-node-id] > [contenteditable="true"]'));
    const idx = editables.indexOf(editable);
    const textsOf = (list: HTMLElement[]) => list.map((e) => plainText(e).trim()).filter(Boolean).join("\n");
    const max = this.plugin.config.contextChars;
    let before = textsOf(editables.slice(0, Math.max(0, idx)));
    if (before.length > max) before = "…" + before.slice(-max);
    let after = "";
    if (mode === "revise" && idx >= 0) {
      after = textsOf(editables.slice(idx + 1));
      if (after.length > max) after = after.slice(0, max) + "…";
    }

    const title = this.protyle.element.querySelector(".protyle-title__input")?.textContent?.trim() || "";

    return {
      title, before, current, currentAfter, after, range, editable,
      anchor: { node: range.startContainer, offset: range.startOffset, blockId: block.getAttribute("data-node-id")! } as Anchor,
    };
  }

  // ---------- 请求 / 显示 ----------

  /** 思源的提示菜单（[[ (( / : 等）打开时让出 Tab / Esc */
  private hintOpen(): boolean {
    const h = this.protyle.hint?.element;
    return !!h && !h.classList.contains("fn__none");
  }

  /**
   * 全局开关、API Key、只读状态都满足、提示菜单未打开时，返回本文档的模式；
   * 本文档未开启或不满足条件时返回 null。
   */
  private activeMode(): GWMode | null {
    const c = this.plugin.config;
    if (!c.enabled || !c.apiKey || this.protyle.disabled || this.hintOpen()) return null;
    const mode = this.plugin.docMode(this.protyle.block?.rootID);
    return mode === "off" ? null : mode;
  }

  /** 手机端「续写」：不需要触发标点，立即请求。写作模式下光标不在段尾时提示原因 */
  private manualRequest() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const mode = this.activeMode();
    if (!mode) return;
    if (!this.collectContext(mode)) {
      if (mode === "write") this.plugin.notify("errContinueAtEnd");
      return;
    }
    this.avoid = [];
    this.request({ manual: true });
  }

  /** 手机端「换一句」：把当前建议记为已否决，在同一插入点重新请求 */
  private regenerate() {
    if (!this.suggestion || !this.anchor) return;
    const rejected = this.suggestion.trim();
    this.avoid = [...this.avoid.filter((s) => s !== rejected), rejected].slice(-MAX_AVOID);
    this.request({ manual: true, avoid: this.avoid });
  }

  private async request(opts: RequestOptions = {}) {
    const mode = this.activeMode();
    if (!mode) return;
    const ctx = this.collectContext(mode);
    if (!ctx || (!opts.manual && !this.endsWithTrigger(ctx.current))) return;
    const seq = ++this.seq;
    this.abort?.abort();
    this.abort = new AbortController();
    this.suggestion = "";
    this.anchor = ctx.anchor;
    // 光标后还有文字时不能把建议盖在原文上，改为在该行下方显示卡片
    this.card = !!ctx.currentAfter;
    this.loading = true;
    this.render("", ctx.range, ctx.editable, true);

    try {
      const text = await predictNextSentence(this.plugin.config, {
        mode, lang: this.plugin.promptLang, title: ctx.title, before: ctx.before, current: ctx.current,
        currentAfter: ctx.currentAfter, after: ctx.after, signal: this.abort.signal,
        avoid: opts.avoid?.length ? [...opts.avoid] : undefined,
      });
      if (seq !== this.seq) return;
      this.loading = false;
      if (!this.anchor || this.activeMode() !== mode) return this.hide();
      // 光标还在原处才显示
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return this.hide();
      const r = sel.getRangeAt(0);
      if (r.startContainer !== this.anchor.node || r.startOffset !== this.anchor.offset) return this.hide();
      if (!text) return this.hide();
      this.suggestion = text;
      this.render(text, r, ctx.editable, false);
    } catch (err: any) {
      if (seq !== this.seq) return;
      this.hide();
      if (err?.name === "AbortError") return;
      console.warn("[ghostwriter]", err);
      if (this.activeMode()) this.plugin.reportRequestError(err);
    }
  }

  private render(text: string, range: Range, editable: HTMLElement, loading: boolean) {
    if (this.mobile && loading) {
      // 手机端请求中只在操作栏显示进度，行内不放占位，避免文字跳动
      this.overlay.style.display = "none";
      this.overlay.textContent = "";
      this.syncBar();
      return;
    }
    let rect = range.getBoundingClientRect();
    const edRect = editable.getBoundingClientRect();
    const cs = getComputedStyle(editable);
    if (rect.width === 0 && rect.height === 0) {
      // 空块或光标落在元素边界时拿不到矩形：退回到块内容末尾，空块则是块的开头
      const rects = range.getClientRects();
      rect = rects.length ? rects[rects.length - 1]
        : contentEndRect(editable) ?? new DOMRect(edRect.left, edRect.top, 0, parseFloat(cs.lineHeight) || 24);
    }
    const o = this.overlay;
    o.style.font = cs.font;
    o.style.lineHeight = cs.lineHeight;
    o.style.letterSpacing = cs.letterSpacing;
    /** 手机端灰字一行的高度（px）：行内沿用正文行高，折行后与正文各行对齐；卡片用紧凑行高 */
    let mobileLine = 0;
    if (this.mobile) {
      o.style.fontSize = MOBILE_GHOST_FONT_PX + "px";
      if (this.card) o.style.lineHeight = String(MOBILE_CARD_LINE_HEIGHT);
      mobileLine = this.card ? MOBILE_GHOST_FONT_PX * MOBILE_CARD_LINE_HEIGHT
        : parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.6;
    }
    o.classList.toggle("gw-ghost--card", this.card);

    const remain = edRect.right - rect.right;
    if (this.card) {
      // 改稿模式、光标在段中：卡片放在光标所在行的下方，不遮挡同一行里光标后的文字
      const left = Math.max(edRect.left, Math.min(rect.left, edRect.right - 240));
      o.style.left = left + "px";
      o.style.top = rect.bottom + 4 + "px";
      o.style.maxWidth = Math.max(240, edRect.right - left) + "px";
    } else if (remain < 120) {
      // 右侧放不下：折到下一行行首
      o.style.left = edRect.left + "px";
      o.style.top = rect.bottom + "px";
      o.style.maxWidth = edRect.width + "px";
    } else {
      o.style.left = rect.right + "px";
      // 手机端灰字比正文小：把第一行垂直居中在光标所在行上，否则会偏下
      o.style.top = (this.mobile ? rect.top + rect.height / 2 - mobileLine / 2 : rect.top) + "px";
      o.style.maxWidth = remain + "px";
    }
    o.classList.toggle("gw-ghost--loading", loading);
    o.textContent = text;
    if (this.mobile) {
      // 手机屏幕窄：最多显示几行；采纳方式由操作栏和点按灰字提供，不显示 Tab 提示
      o.style.maxHeight = Math.ceil(mobileLine * MOBILE_MAX_LINES) + (this.card ? 6 : 0) + "px";
    } else if (!loading && text) {
      const hint = document.createElement("span");
      hint.className = "gw-ghost__hint";
      hint.textContent = "Tab";
      o.appendChild(hint);
    }
    o.style.display = "block";
    if (this.mobile) {
      this.syncBar();
      this.keepAboveBar();
    }
  }

  /** 手机端：灰字被操作栏挡住时，把编辑区向上滚一点 */
  private keepAboveBar() {
    const barTop = this.bar?.top();
    const content = this.protyle.contentElement;
    if (barTop == null || !content || this.overlay.style.display !== "block") return;
    const overlap = this.overlay.getBoundingClientRect().bottom - barTop + 8;
    if (overlap > 0) content.scrollTop += overlap;
  }

  /** 手机端：滚动、键盘弹出、视口变化后按插入点重新定位灰字和操作栏；插入点已失效则收起 */
  private reposition = () => {
    if (this.reflowPending) return;
    this.reflowPending = true;
    requestAnimationFrame(() => {
      this.reflowPending = false;
      this.bar?.position();
      const anchor = this.anchor;
      if (!anchor || !this.suggestion) return;
      const editable = this.editableOf(anchor.blockId);
      if (!anchor.node.isConnected || !editable?.contains(anchor.node)) return this.hide();
      const range = document.createRange();
      try {
        range.setStart(anchor.node, anchor.offset);
      } catch {
        return this.hide();
      }
      range.collapse(true);
      this.render(this.suggestion, range, editable, false);
    });
  };

  /** 手机端点按灰字：采纳到所点分句的结尾（设置关闭时采纳整句） */
  private onGhostTap = (e: PointerEvent) => {
    const text = this.suggestion;
    if (!text) return;
    if (!this.plugin.config.mobileClauseAccept) return this.accept();
    const node = this.overlay.firstChild;
    const index = node instanceof Text ? charIndexAt(node, e.clientX, e.clientY) : -1;
    this.accept(index < 0 ? text.length : clauseEnd(text, index));
  };

  /**
   * 采纳建议的前 length 个字符（缺省为整句）。只采纳一部分时，剩余部分留在新光标处继续作为建议；
   * 整句采纳完、处于写作模式时顺势预测下一句。
   */
  private accept(length?: number) {
    const text = this.suggestion;
    const anchor = this.anchor;
    this.hide();
    const mode = this.activeMode();
    if (!text || !anchor || !mode) return;
    const n = length && length > 0 && length < text.length ? length : text.length;
    const rest = text.slice(n);
    this.avoid = [];
    if (!this.insertLiteral(text.slice(0, n), anchor.blockId)) return;
    if (rest.trim()) {
      // 等思源处理完插入后的光标再定位；其间的 selectionchange 因为没有锚点而被忽略，
      // 期间若继续输入，cancel() 会让 seq 变化，剩余部分不再显示
      const seq = this.seq;
      window.setTimeout(() => { if (seq === this.seq) this.showRemainder(rest, mode); });
      return;
    }
    // 写作模式：采纳的句子通常也以标点结尾，顺势预测下一句，形成连续写作。
    // 改稿模式是单点插入，不自动续接
    if (mode === "write" && this.plugin.config.chainAfterAccept) {
      this.timer = window.setTimeout(() => this.request(), this.delay);
    }
  }

  /** 分句采纳后，把剩余的建议显示在新的光标处 */
  private showRemainder(rest: string, mode: GWMode) {
    if (this.activeMode() !== mode) return;
    const ctx = this.collectContext(mode);
    if (!ctx) return;
    this.anchor = ctx.anchor;
    this.card = !!ctx.currentAfter;
    this.suggestion = rest;
    this.render(rest, ctx.range, ctx.editable, false);
  }

  private editableOf(blockId: string): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(blockId)}"] > [contenteditable="true"]`);
  }

  /** 手机端操作栏：本文档已开启、编辑器有焦点（软键盘弹出）时显示 */
  private syncBar = () => {
    if (!this.bar) return;
    const mode = this.activeMode();
    const active = document.activeElement;
    this.bar.update({
      visible: !!mode && !!active && this.el.contains(active),
      mode: mode ? this.plugin.shortModeLabel(mode) : "",
      loading: this.loading,
      suggestion: !!this.suggestion && !this.loading,
    });
  };

  /**
   * 在光标处按原文插入文字。思源 3.8.7 没有导出 insertContent；protyle.insert 收到的普通文本
   * 会在保存时被当成 Markdown（**a** 变加粗、((id)) 变块引用），所以用 Lute 生成行内 DOM：
   * 不含行内语法的文字原样插入，否则先转义再插入。
   * 返回块文字是否确实变长了。
   */
  private insertLiteral(text: string, blockId: string): boolean {
    const lute = this.protyle.lute;
    if (!lute) return false;
    const render = (md: string) => {
      const tpl = document.createElement("template");
      tpl.innerHTML = lute.InlineMd2BlockDOM(md);
      return tpl.content.querySelector<HTMLElement>('[data-type="NodeParagraph"] > [contenteditable="true"]');
    };
    const unescaped = render(text);
    const html = unescaped && isPlainTextRender(unescaped, text)
      ? unescaped.innerHTML : render(escapeMarkdownInline(text))?.innerHTML;
    if (!html) return false;
    const before = plainText(this.editableOf(blockId)).length;
    this.protyle.getInstance().insert(html, false, false);
    return plainText(this.editableOf(blockId)).length > before;
  }

  hide = () => {
    this.suggestion = "";
    this.anchor = undefined;
    this.loading = false;
    this.overlay.style.display = "none";
    this.overlay.textContent = "";
    this.syncBar();
  };

  private cancel() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.abort?.abort();
    this.seq++;
    this.hide();
  }
}

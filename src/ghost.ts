import type { IProtyle } from "siyuan";
import type GhostWriterPlugin from "./index";
import { predictNextSentence } from "./llm";

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

  constructor(public readonly protyle: IProtyle, private plugin: GhostWriterPlugin) {
    this.el = protyle.wysiwyg!.element;
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

    this.el.addEventListener("input", this.onInput);
    this.el.addEventListener("compositionstart", this.dismiss);
    this.el.addEventListener("compositionend", this.onInput);
    this.el.addEventListener("keydown", this.onKeydown, true);
    this.el.addEventListener("mousedown", this.dismiss);
    this.el.addEventListener("focusout", this.onFocusOut);
    protyle.contentElement?.addEventListener("scroll", this.hide, { passive: true });
    document.addEventListener("selectionchange", this.onSelectionChange);
    window.addEventListener("resize", this.hide);
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
    this.protyle.contentElement?.removeEventListener("scroll", this.hide);
    document.removeEventListener("selectionchange", this.onSelectionChange);
    window.removeEventListener("resize", this.hide);
    this.overlay.remove();
  }

  // ---------- 事件 ----------

  private onInput = (e: Event) => {
    if ((e as InputEvent).isComposing) return; // 中文输入法组字阶段不触发
    this.cancel();
    if (!this.isActive()) return;
    const ctx = this.collectContext();
    if (!ctx || !this.endsWithTrigger(ctx.current)) return;
    this.timer = window.setTimeout(() => this.request(), this.plugin.config.delay);
  };

  /** 开始组字、点击编辑器：取消待发请求和已显示的建议 */
  private dismiss = () => this.cancel();

  /** 焦点离开编辑器（切到其它面板、页签等）时收起 */
  private onFocusOut = (e: FocusEvent) => {
    if (e.relatedTarget instanceof Node && this.el.contains(e.relatedTarget)) return;
    this.cancel();
  };

  private onKeydown = (e: KeyboardEvent) => {
    if (!this.suggestion || e.isComposing) return;
    if (!this.isActive()) {
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

  private collectContext() {
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
    const after = r.toString().replace(ZW, "").trim();
    if (after) return null; // 只在块尾预测

    // 前文：文档中当前块之前的所有叶子块文本
    const editables = Array.from(
      this.el.querySelectorAll<HTMLElement>('[data-node-id] > [contenteditable="true"]'));
    const idx = editables.indexOf(editable);
    const parts: string[] = [];
    for (let i = 0; i < idx; i++) {
      const t = plainText(editables[i]).trim();
      if (t) parts.push(t);
    }
    let before = parts.join("\n");
    const max = this.plugin.config.contextChars;
    if (before.length > max) before = "…" + before.slice(-max);

    const title = this.protyle.element.querySelector(".protyle-title__input")?.textContent?.trim() || "";

    return {
      title, before, current, range, editable,
      anchor: { node: range.startContainer, offset: range.startOffset, blockId: block.getAttribute("data-node-id")! } as Anchor,
    };
  }

  // ---------- 请求 / 显示 ----------

  /** 思源的提示菜单（[[ (( / : 等）打开时让出 Tab / Esc */
  private hintOpen(): boolean {
    const h = this.protyle.hint?.element;
    return !!h && !h.classList.contains("fn__none");
  }

  /** 全局开关、API Key、只读状态、本文档开关都满足，且提示菜单未打开时才工作 */
  private isActive(): boolean {
    const c = this.plugin.config;
    return c.enabled && !!c.apiKey && !this.protyle.disabled
      && this.plugin.isDocEnabled(this.protyle.block?.rootID) && !this.hintOpen();
  }

  private async request() {
    if (!this.isActive()) return;
    const ctx = this.collectContext();
    if (!ctx || !this.endsWithTrigger(ctx.current)) return;
    const seq = ++this.seq;
    this.abort?.abort();
    this.abort = new AbortController();
    this.anchor = ctx.anchor;
    this.render("", ctx.range, ctx.editable, true);

    try {
      const text = await predictNextSentence(this.plugin.config, {
        title: ctx.title, before: ctx.before, current: ctx.current, signal: this.abort.signal,
      });
      if (seq !== this.seq) return;
      if (!this.anchor || !this.isActive()) return this.hide();
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
      if (this.isActive()) this.plugin.reportRequestError(err);
    }
  }

  private render(text: string, range: Range, editable: HTMLElement, loading: boolean) {
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

    const remain = edRect.right - rect.right;
    if (remain < 120) {
      // 右侧放不下：折到下一行行首
      o.style.left = edRect.left + "px";
      o.style.top = rect.bottom + "px";
      o.style.maxWidth = edRect.width + "px";
    } else {
      o.style.left = rect.right + "px";
      o.style.top = rect.top + "px";
      o.style.maxWidth = remain + "px";
    }
    o.classList.toggle("gw-ghost--loading", loading);
    o.textContent = text;
    if (!loading && text) {
      const hint = document.createElement("span");
      hint.className = "gw-ghost__hint";
      hint.textContent = "Tab";
      o.appendChild(hint);
    }
    o.style.display = "block";
  }

  private accept() {
    const text = this.suggestion;
    const anchor = this.anchor;
    this.hide();
    if (!text || !anchor || !this.isActive()) return;
    if (!this.insertLiteral(text, anchor.blockId)) return;
    // 采纳的句子通常也以标点结尾，顺势预测下一句，形成连续写作
    if (this.plugin.config.chainAfterAccept) {
      this.timer = window.setTimeout(() => this.request(), this.plugin.config.delay);
    }
  }

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
    const editableOf = () => this.el.querySelector(`[data-node-id="${CSS.escape(blockId)}"] > [contenteditable="true"]`);
    const before = plainText(editableOf()).length;
    this.protyle.getInstance().insert(html, false, false);
    return plainText(editableOf()).length > before;
  }

  hide = () => {
    this.suggestion = "";
    this.anchor = undefined;
    this.overlay.style.display = "none";
    this.overlay.textContent = "";
  };

  private cancel() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.abort?.abort();
    this.seq++;
    this.hide();
  }
}

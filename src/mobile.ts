/**
 * 手机端（mobile / browser-mobile）专用：分句采纳、触控点按、键盘上方的操作栏。
 * 本文件不引用 siyuan 的运行时导出，纯逻辑部分可以单独做单元测试。
 */

/** 分句结束符：中英文逗号、顿号、分号、冒号、句号、问号、叹号、省略号 */
const CLAUSE_END = /[，、；：。！？,;:.!?…]/;
/** 紧跟在结束符之后、应一并采纳的闭合引号和括号 */
const CLOSERS = /[”’」』）)\]"'》〉]/;

/**
 * 点按灰字中第 offset 个字符时应采纳的长度：到该字符所在分句的结束符为止，
 * 连续的结束符（？！、……）和其后的闭合引号、括号一并采纳。
 * 英文的 . , : 后紧跟字母或数字时（3.14、1,000、12:30）不算分句结束。没有结束符时采纳整句。
 */
export function clauseEnd(text: string, offset: number): number {
  const n = text.length;
  if (!n) return 0;
  for (let i = Math.max(0, Math.min(offset, n - 1)); i < n; i++) {
    const ch = text[i];
    if (!CLAUSE_END.test(ch)) continue;
    if (".,:".includes(ch) && /[A-Za-z0-9]/.test(text[i + 1] || "")) continue;
    let j = i + 1;
    while (j < n && (CLAUSE_END.test(text[j]) || CLOSERS.test(text[j]))) j++;
    return j;
  }
  return n;
}

/**
 * 触控点按：pointerdown 时阻止默认行为，编辑器不会失焦、软键盘不会收起；
 * 在同一元素内抬起才算点按，移出元素再抬起视为取消。
 * 同时拦截 touchstart / mousedown / click 的默认行为，防止兼容事件抢走焦点或重复触发。
 * 返回解除绑定的函数。
 */
export function bindTap(el: HTMLElement, onTap: (e: PointerEvent) => void): () => void {
  let pointer: number | null = null;
  const down = (e: PointerEvent) => {
    if (e.button > 0) return;
    e.preventDefault();
    pointer = e.pointerId;
  };
  const up = (e: PointerEvent) => {
    if (pointer !== e.pointerId) return;
    pointer = null;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    onTap(e);
  };
  const cancel = () => { pointer = null; };
  const block = (e: Event) => e.preventDefault();
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("touchstart", block, { passive: false });
  el.addEventListener("mousedown", block);
  el.addEventListener("click", block);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
    el.removeEventListener("touchstart", block);
    el.removeEventListener("mousedown", block);
    el.removeEventListener("click", block);
  };
}

/** 点 (x, y) 到矩形的距离；点在矩形内为 0 */
export function distanceToRect(x: number, y: number, r: { left: number; right: number; top: number; bottom: number }): number {
  const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
  const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
  return Math.hypot(dx, dy);
}

/**
 * 点按位置对应 textNode 中的第几个字符：取包含该点的字符，点在行间或内边距上时取最近的字符；
 * 文本为空时返回 -1。灰字是 user-select: none，caretRangeFromPoint 在其中不可靠，所以逐字比对矩形。
 */
export function charIndexAt(textNode: Text, x: number, y: number): number {
  const len = textNode.data.length;
  const r = document.createRange();
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < len; i++) {
    r.setStart(textNode, i);
    r.setEnd(textNode, i + 1);
    for (const rect of Array.from(r.getClientRects())) {
      const d = distanceToRect(x, y, rect);
      if (d === 0) return i;
      if (d < bestDist) { bestDist = d; best = i; }
    }
  }
  return best;
}

export interface BarLabels {
  accept: string;
  regenerate: string;
  dismiss: string;
  continue: string;
  mode: string;
}

export interface BarActions {
  accept(): void;
  regenerate(): void;
  dismiss(): void;
  continue(): void;
  openMode(button: HTMLElement): void;
}

export interface BarState {
  visible: boolean;
  /** 当前文档模式的短名称，显示在左侧按钮上 */
  mode: string;
  loading: boolean;
  suggestion: boolean;
}

/**
 * 软键盘上方的操作栏，紧贴在思源的键盘工具栏 #keyboardToolbar 之上：
 * 左侧是本文档模式；空闲时右侧是「续写」，有建议时是「换一句 ✕ 采纳」，请求中顶部显示进度条。
 */
export class MobileBar {
  readonly el: HTMLDivElement;
  private modeBtn: HTMLButtonElement;
  private continueBtn: HTMLButtonElement;
  private regenBtn: HTMLButtonElement;
  private dismissBtn: HTMLButtonElement;
  private acceptBtn: HTMLButtonElement;
  private unbind: (() => void)[] = [];
  private resizeObserver: ResizeObserver | undefined;
  private observedToolbar: Element | null = null;
  private visible = false;

  constructor(labels: BarLabels, actions: BarActions) {
    const el = document.createElement("div");
    el.className = "gw-bar";
    el.style.display = "none";
    el.innerHTML = '<div class="gw-bar__progress"></div>';
    const btn = (cls: string, text: string, label: string, onTap: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.tabIndex = -1;
      b.className = "gw-bar__btn " + cls;
      b.textContent = text;
      b.setAttribute("aria-label", label);
      this.unbind.push(bindTap(b, onTap));
      return b;
    };
    this.modeBtn = btn("gw-bar__mode", "", labels.mode, () => actions.openMode(this.modeBtn));
    const spacer = document.createElement("span");
    spacer.className = "gw-bar__spacer";
    this.continueBtn = btn("gw-bar__continue", labels.continue, labels.continue, () => actions.continue());
    this.regenBtn = btn("gw-bar__regen", labels.regenerate, labels.regenerate, () => actions.regenerate());
    this.dismissBtn = btn("gw-bar__dismiss", "✕", labels.dismiss, () => actions.dismiss());
    this.acceptBtn = btn("gw-bar__btn--primary gw-bar__accept", labels.accept, labels.accept, () => actions.accept());
    el.append(this.modeBtn, spacer, this.continueBtn, this.regenBtn, this.dismissBtn, this.acceptBtn);
    // 点在按钮之间的空隙上也不能让编辑器失焦
    const block = (e: Event) => e.preventDefault();
    el.addEventListener("pointerdown", block);
    el.addEventListener("mousedown", block);
    el.addEventListener("touchstart", block, { passive: false });
    this.unbind.push(() => {
      el.removeEventListener("pointerdown", block);
      el.removeEventListener("mousedown", block);
      el.removeEventListener("touchstart", block);
    });
    document.body.appendChild(el);
    this.el = el;

    window.visualViewport?.addEventListener("resize", this.position);
    window.visualViewport?.addEventListener("scroll", this.position);
    window.addEventListener("resize", this.position);
  }

  update(state: BarState) {
    this.visible = state.visible;
    this.el.style.display = state.visible ? "flex" : "none";
    if (!state.visible) return;
    this.modeBtn.textContent = state.mode + " ▾";
    this.el.classList.toggle("gw-bar--loading", state.loading);
    this.continueBtn.hidden = state.loading || state.suggestion;
    this.regenBtn.hidden = !state.suggestion;
    this.dismissBtn.hidden = !state.loading && !state.suggestion;
    this.acceptBtn.hidden = !state.suggestion;
    this.position();
  }

  /** 顶边：思源键盘工具栏可见时在它上方，否则在可视区域（软键盘之上）的底部 */
  position = () => {
    if (!this.visible) return;
    const vv = window.visualViewport;
    let bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const toolbar = document.getElementById("keyboardToolbar");
    if (toolbar !== this.observedToolbar) {
      this.resizeObserver?.disconnect();
      this.observedToolbar = toolbar;
      if (toolbar && typeof ResizeObserver === "function") {
        this.resizeObserver = new ResizeObserver(() => this.position());
        this.resizeObserver.observe(toolbar);
      }
    }
    if (toolbar && toolbar.offsetHeight > 0 && !toolbar.classList.contains("fn__none")) {
      const top = toolbar.getBoundingClientRect().top;
      if (top > 0 && top < bottom) bottom = top;
    }
    this.el.style.left = (vv?.offsetLeft ?? 0) + "px";
    this.el.style.width = (vv?.width ?? window.innerWidth) + "px";
    this.el.style.top = Math.max(0, bottom - this.el.offsetHeight) + "px";
  };

  /** 操作栏的顶边；不可见时返回 null */
  top(): number | null {
    return this.visible ? this.el.getBoundingClientRect().top : null;
  }

  destroy() {
    this.unbind.forEach((f) => f());
    this.resizeObserver?.disconnect();
    window.visualViewport?.removeEventListener("resize", this.position);
    window.visualViewport?.removeEventListener("scroll", this.position);
    window.removeEventListener("resize", this.position);
    this.el.remove();
  }
}

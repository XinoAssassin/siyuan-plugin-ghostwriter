# AGENTS.md: Ghost Writer (写稿助手) maintenance guide

Notes for coding agents and maintainers. Read this before changing code or cutting a release.

## What it is

A SiYuan Note frontend plugin. When the user types sentence punctuation at the end of a block, it asks an
OpenAI-compatible `/chat/completions` endpoint for the next sentence. The answer is shown as grey "ghost text" in an
overlay next to the caret: `Tab` accepts it, `Esc` dismisses it.
- Each document has a mode: **off** (default), **write** (continue at the end of a block; reads only text before the
  caret) or **revise** (caret may be mid-paragraph; reads text before *and* after; suggests one sentence to insert at
  the caret). Each mode has its own system prompt and user template.
- There is a global on/off switch (`Alt+Shift+G`).

- Marketplace: listed through `siyuan-note/bazaar` PR #2367 (`plugins.txt` line `XinoAssassin/siyuan-plugin-ghostwriter`).
- Targets SiYuan ≥ 3.8.4 (developed and tested on 3.8.7), desktop / desktop-window / browser-desktop only.

## File map

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry (`GhostWriterPlugin`). Config load/save and settings UI, per-document mode (`docModes`, `docs.json`), breadcrumb button + mode menu, title-icon submenu, commands, error toasts, attaching one `GhostWriter` per editor. |
| `src/ghost.ts` | `GhostWriter`, one per editor instance (protyle). Input/IME/keyboard handling, context collection, request lifecycle, overlay rendering, accept/insert. |
| `src/llm.ts` | Pure logic, unit-testable. `GWMode`, prompt defaults for both modes, `promptsFor`, `renderTemplate`, request-body construction, `extraBody`/baseURL validation, response normalization (`contentText`, `clean`), `predictNextSentence` (direct `fetch` or kernel `forwardProxy`), `GhostWriterError`. |
| `src/index.css` | Overlay (`.gw-ghost*`, `.gw-ghost--card` for mid-paragraph revise suggestions) and breadcrumb button state (`.gw-doc-mode--write` / `--revise`, with W/R badge). |
| `i18n/zh_CN.json`, `i18n/en_US.json` | UI strings. **Keep keys in parity.** `err*` keys are error toasts, with `{param}` placeholders. |
| `vite.config.ts` | Build. `dev`/`build` → `SIYUAN_PLUGIN_DIR` (env or git-ignored `.env.local`), falling back to `dist/`; `package` → clean `dist/` + `package.zip` (adm-zip). |
| `plugin.json` | Marketplace manifest. `name` must equal the repo name; locale keys are BCP 47 (`zh-CN`). |

## Runtime flow

1. `input`/`compositionend` → `onInput`: cancel anything pending. Then, if `activeMode()` is non-null and the text up
   to the caret ends with a trigger char → start the debounce timer (`delay`).
   - **write:** only when the caret is at the **end** of the block (`collectContext` returns null otherwise).
   - **revise:** anywhere in the block; also collects `currentAfter` (rest of the block) and `after` (following blocks).
2. Timer → `request()`:
   - re-check `activeMode()`, re-collect context, re-check the trigger char;
   - `seq++`, new `AbortController`, show the loading overlay (`card` = true when `currentAfter` is non-empty);
   - call `predictNextSentence` with `mode`; `buildMessages` picks that mode's prompts via `promptsFor`.
3. After `await`: drop the result if `seq` changed, if `activeMode()` changed, or if the caret moved from the anchor
   (`node` + `offset`). Otherwise render the suggestion (inline after the caret, or as a card below the line).
4. `Tab` (capture phase, only while a suggestion is visible and SiYuan's hint menu is closed) → `accept()` →
   `insertLiteral()` at the caret. In **write** mode only, chain the next prediction, and only if the insert actually
   lengthened the block.

`activeMode()` = the document's mode when global `enabled` && `apiKey` set && editor not read-only && hint menu
closed && mode ≠ off; otherwise null.

What cancels or hides a suggestion:
- **Cancels:** `compositionstart`, `mousedown`, `focusout`.
- **Hides:** scroll, resize, `switch-protyle`, a caret move (`selectionchange`), saving settings with the plugin disabled, changing the doc's mode.

## Invariants and hard-won gotchas (do not regress)

1. **The overlay never touches editor DOM.** It is a `position: fixed` div on `document.body`. Writing into protyle
   DOM would trigger SiYuan transactions, pollute undo, and risk saving ghost text into the document.
2. **Accepting must insert literal text, but must not pollute Markdown source.**
   - SiYuan 3.8.7 does **not** export `insertContent` (it exists in newer typings only).
   - `protyle.insert(escapeHtml(text))` is **not** literal: the kernel re-parses `**a**`, `$x$`, `((id))`, `[[x]]` into real syntax.
   - Always backslash-escaping is wrong too: ordinary prose like `AMD (x)!` gets stored as `AMD \(x\)\!`.
   - Current approach (`insertLiteral`):
     - Render the *unescaped* text with `lute.InlineMd2BlockDOM`.
     - If `isPlainTextRender` (no child elements, text unchanged), insert that.
     - Otherwise insert the `escapeMarkdownInline` version.
   - Verify changes here with `lute.BlockDOM2StdMd` and by exporting the doc (`/api/export/exportMdContent`).
3. **Breadcrumb button identity.**
   - `addBreadcrumbButton` returns the bare id.
   - The rendered DOM uses `data-id="<plugin-name>:<id>"` plus `data-plugin-name`.
   - The button can appear *after* `loaded-protyle-*` fires, so each `GhostWriter` keeps a `MutationObserver` on `.protyle-breadcrumb__plugin` (disconnected in `destroy()`).
   - Do not rely on `requestAnimationFrame`: it never fires while the window is hidden.
4. **IME.** Ignore `input` with `isComposing`. Trigger on `compositionend`. Cancel on `compositionstart`. Ignore keydown while composing.
5. **Tab precedence.** While a suggestion is visible, Tab accepts it even inside list items (by design). It must **not**
   intercept Tab/Esc while SiYuan's hint menu (`[[`, `((`, `:` emoji, `/`) is open.
6. **Stale responses.** Every async boundary re-checks `seq` / anchor / `isActive()`. The proxy path cannot truly abort the
   upstream call (the kernel finishes its own request), so the `seq` check is what keeps results correct.
7. **Request body.** The order is `defaults → ...extraBody → model/messages/stream:false` (re-asserted last).
   - `extraBody` must be a JSON **object**, validated on save and at request time.
   - It may override `max_tokens`/`temperature` (needed for Gemini).
8. **Thinking models.**
   - Gemini 3.x cannot fully disable thinking (2.5 can with `reasoning_effort: "none"`).
   - Gemini's `max_tokens` includes thinking tokens, so a small value yields empty `content`.
   - Empty content plus `reasoning_content` or `finish_reason: "length"` → `errNoContent` toast (tells the user to disable thinking or raise `max_tokens`).
   - DeepSeek: `{"thinking":{"type":"disabled"}}` (thinking is on by default for `deepseek-flash`).
9. **Kernel `forwardProxy`** (`/api/network/forwardProxy`):
   - Its HTTP client does **not** use SiYuan's network-proxy setting.
   - It blocks loopback/private addresses when SafeMode is on, so local LLMs must use direct mode.
   - Headers are passed as an array of single-key objects. Response `body` is text with `responseEncoding: "text"`.
10. **Errors.**
    - Throw `GhostWriterError(key, params)`; `index.ts#reportRequestError` maps it to an `err*` i18n key.
    - The message is HTML-escaped, the API key is redacted to `***`, it is truncated to 300 chars, and the same message is shown at most once per 60 s.
    - Never log or display the API key.
11. **Config persistence.**
    - `loadConfig` type-checks each saved key and falls back to defaults, so old configs missing keys keep working.
    - Prompts equal to the defaults are stored as `""` so future default changes reach users.
    - Number inputs: empty → default, clamped with `Number.isFinite`.
12. **Context limits.**
    - "Before" text = all leaf blocks *currently loaded in the DOM* before the caret block, trimmed to its last `contextChars` chars (not tokens).
    - "After" text (revise only) = leaf blocks loaded after the caret block, trimmed to its first `contextChars` chars.
    - SiYuan lazy-loads long docs, so the start or end of a long document may be missing.
13. **Per-document modes (`docs.json`).**
    - Format `{ "modes": { "<rootID>": "write" | "revise" } }`; missing = off. `loadDocModes` also accepts the 0.1.0
      format `{ "enabled": [rootID] }` (→ write) and ignores unknown values.
    - Prompts are per mode: `systemPrompt`/`userTemplate` (write), `reviseSystemPrompt`/`reviseUserTemplate` (revise);
      `""` = that mode's default.
    - Defaults exist in **zh and en** (`DEFAULT_*` / `DEFAULT_*_EN`, `defaultPrompt(key, lang)`). The language is the
      SiYuan UI language at request time (`plugin.promptLang` → `promptLangFor(window.siyuan.config.lang)`: `zh*` → zh,
      else en; 3.8.7 reports `zh-CN`). `isDefaultPrompt` treats empty **or either language's default** as "use default",
      both when loading/saving and in `promptsFor`, so stored defaults follow UI-language switches. Custom text is never
      translated or replaced. Keep the zh/en defaults semantically in sync when editing either. Revise templates get extra variables `{{currentAfter}}` and `{{after}}`.
    - `clean(raw, current, currentAfter)` also strips an output suffix that repeats the start of `currentAfter`, and adds
      spacing on both sides for English text.
14. **Opening a `Menu` from a breadcrumb-button callback.** SiYuan calls the callback inside the click and then clears
    the shared `#commonMenu` ~1 ms later in the same click. Build *and* open the `Menu` in a `setTimeout`, otherwise it
    flashes and disappears. Verify with real mouse events (CDP `Input.dispatchMouseEvent`), not `element.click()` alone.
    In menu items, `checked: true` renders SiYuan's checkmark and `current: true` adds `b3-menu__item--selected`.

## Build, test, release

```bash
npm install
npm run typecheck            # tsc --noEmit
npm run build                # -> $SIYUAN_PLUGIN_DIR (.env.local) or dist/
npm run dev                  # watch mode, same output dir
npm run package              # clean dist/ + package.zip (cross-platform, adm-zip; never shell out to tar)
```

`.env.local` (git-ignored), for live development inside a SiYuan workspace:
```
SIYUAN_PLUGIN_DIR=<workspace>/data/plugins/siyuan-plugin-ghostwriter
```
- The plugin folder must be a **real directory**. SiYuan does not see Windows junctions ("plugin not found").
- A brand-new workspace also needs Settings → Marketplace → trust third-party plugins turned on.

### Testing expectations
- **Unit:** bundle `src/llm.ts` plus `escapeMarkdownInline`/`isPlainTextRender` from `src/ghost.ts` with esbuild,
  aliasing `siyuan` to a stub, then run `node --test`. Cover: `renderTemplate`, `clean`, request body, `extraBody`/baseURL
  validation, `contentText`, and `predictNextSentence` error mapping (401, reasoning-only, length, non-JSON, abort, proxy codes).
- **E2E:** use a real SiYuan desktop with `--remote-debugging-port`, driven over the Chrome DevTools Protocol (CDP), against a mock OpenAI endpoint.
  - Test **only in a throwaway notebook**, and never persist the plugin settings during tests.
  - With a hidden window, enable `Emulation.setFocusEmulationEnabled`, or key events are dropped.
  - Minimum scenarios:
    - the doc mode gates requests (off = none); the breadcrumb menu opens with a real mouse click and switches modes;
    - revise: mid-paragraph trigger sends before/after context with the ▍ marker, shows a card below the line, Tab
      inserts at the caret, no chained request; write: mid-paragraph punctuation sends nothing;
    - Tab inserts literally, and plain prose is stored without backslashes;
    - Esc dismisses;
    - IME / click within the delay sends no request;
    - hint menu open → Tab passes through;
    - 401 and reasoning-only responses produce toasts;
    - the breadcrumb tooltip is correct right after a reload.

### Release checklist (marketplace updates need no new bazaar PR)
1. Bump `version` in `plugin.json` (and `package.json`), semver.
2. Run `npm run typecheck && npm run package`. Inspect `package.zip`:
   - it contains exactly `index.js`, `index.css`, `plugin.json`, `README.md`, `README.zh-CN.md`, `i18n/*`, `icon.png`;
   - it has no local paths, keys or source maps.
3. Publish a GitHub Release (tag = version; `0.1.0` was used without a `v` prefix), marked Latest, not a pre-release.
4. **Attach the asset with the exact name `package.zip`.**
   - The bazaar checker matches `asset.GetName() == "package.zip"` (`siyuan-note/bazaar` `actions/util/release.go`).
   - `0.1.0.zip` was rejected-in-waiting once.
5. The indexer skips a release whose `package.zip` is byte-identical to the indexed one. Always rebuild after the version bump.
6. The bazaar Stage workflow picks the release up within ~1–3 h. Failures appear as `stage-fail` issues in `siyuan-note/bazaar`.

## Known limitations / backlog
- Non-streaming only. Streaming (SSE) would cut perceived latency. The proxy path cannot stream.
- Revise mode uses chat completions with a ▍ marker, not a native FIM endpoint (e.g. DeepSeek FIM beta).
- Context is character-based and DOM-limited (see invariant 12). There is no token budgeting.
- Keyless local servers (Ollama, LM Studio) need a dummy API key.
- Accepted text containing Markdown syntax is stored with backslash escapes, which are visible in raw Markdown export.
- Leaving the window (Alt-Tab) dismisses the suggestion, because `focusout` fires.
- No mobile frontends.
- `npm audit` findings in dev dependencies have not been reviewed.

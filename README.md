# Ghost Writer

When you type punctuation, Ghost Writer asks an LLM (through the Google Gemini native API or an OpenAI-compatible API) for a one-sentence suggestion and shows it as grey ghost text at the caret. Press `Tab` to accept it. There are two modes:

- **Writing mode:** continues at the end of a paragraph, reads only the text before the caret, and predicts the next sentence.
- **Revision mode:** the caret may be mid-paragraph; it reads the text before *and after* the caret and suggests one sentence to insert at the caret that bridges both.

Each mode has its own prompts, and the default prompts come in Chinese and English, following SiYuan's interface language.

The API format is detected automatically by default: Gemini / Gemma models use the Gemini native API when available and fall back to the OpenAI-compatible API; other models use the OpenAI-compatible API. Enter the base URL as usual; see the [API auto-detection rules](#api-auto-detection-rules).

> **Every document is off by default.** After setting an API key, choose a mode for each document you want it in (see below). Documents that are off show nothing and send no requests.

## Usage

### Choosing a mode

- **Per document: Off / Writing mode / Revision mode (default off).** Use any of these; the choice is remembered per document.
  - Click the ghost button in the editor's breadcrumb bar (top right) and pick a mode from the menu. The button's colour and badge show the current mode: theme colour with a "W" badge for writing, green with an "R" badge for revision.
  - The document title icon menu → "Ghost Writer: <current mode>" submenu.
  - The command "Ghost Writer: cycle mode for this document" (off → writing → revision). It has no default shortcut; you can bind one in Settings → Keymap, in the plugin section.
- **Global switch:** `Alt+Shift+G` (or "Enabled" in the plugin settings). This turns predictions on or off everywhere without changing the per-document modes.
- When upgrading from 0.1.0, documents that were switched on become writing mode.

### Writing mode

- A prediction is requested after you type one of the trigger punctuation marks (default `，。！？；：,.!?;:`) and pause for the debounce delay (default 400 ms).
- It is only requested when all of these hold:
  - the caret is at the end of the block
  - you are not composing with an IME
  - the editor is not read-only
- No predictions in code, math, HTML, table, database, iframe, widget, video or audio blocks, or inside embed blocks.
- `Tab` accepts the suggestion. Ghost Writer then predicts the following sentence straight away, so you can keep pressing `Tab` to keep writing.

### Revision mode

- Works with the caret mid-paragraph or at the end: type a trigger punctuation mark at the caret (for example add a "，" after a sentence) and pause. IME, read-only and block-type restrictions are the same as in writing mode.
- Besides the preceding text and the paragraph up to the caret, it also sends the rest of the paragraph after the caret and the following blocks (also capped by "Max context characters"). The model returns one sentence to **insert at the caret** that connects what comes before and after.
- When there is text after the caret, the suggestion is shown as a small card below the current line so it doesn't cover your text. At the end of a paragraph it is shown inline, as in writing mode.
- `Tab` inserts the suggestion at the caret. Revision is a single insertion, so no follow-up prediction is made after accepting.

### Both modes

- `Esc` dismisses it. Typing, clicking, moving the caret, scrolling or leaving the editor also dismisses it.
- `Tab` and `Esc` are left to SiYuan while its hint menu is open (`/`, `[[`, `((`, `:` and similar). No predictions are requested then either.
- While a suggestion is showing, `Tab` accepts it instead of indenting a list item. `Shift+Tab` and `Ctrl+Tab` are never intercepted.
- The ghost text is an overlay. It never touches the document or the undo stack until you accept it.
- Accepted text is inserted literally. Markdown characters such as `*`, `$` or `((` are escaped, so they render as plain text. In a raw Markdown export they appear with a backslash.
- Works on desktop (desktop app, desktop windows and desktop browser) and mobile (SiYuan app and mobile browser). The plugin is not loaded on publish-service pages.

### On a phone

Software keyboards have no `Tab` or `Esc`, so SiYuan's mobile interface uses taps instead:

- **Action bar:** while you edit a document that has a mode, a bar appears above the keyboard (above SiYuan's keyboard toolbar).
  - On the left, "Write ▾ / Revise ▾" shows the current mode. Tap it to switch.
  - With no suggestion, the right side shows **Continue**: it requests a sentence right away, with no punctuation needed. In writing mode it only works at the end of a paragraph.
  - With a suggestion, the right side shows **Another ✕ Accept**. **Another** tells the model the previous sentence was rejected and raises the temperature by 0.3. **✕** dismisses the suggestion. **Accept** inserts the whole sentence.
  - A thin progress line runs along the top of the bar while a request is in flight.
- **Tap the ghost text** to accept only up to the end of the tapped clause (clauses end at `,`, `;`, `:`, `.`, `!`, `?`, `，`, `、`, `。` and similar). The rest stays as the suggestion, so you can accept it clause by clause. A setting switches taps to accept the whole sentence.
- Tapping the bar or the ghost text never takes focus from the editor, so the keyboard stays open.
- The ghost text is shown in a smaller 12px font, at most 3 lines. If the bar would cover it, the editor scrolls up. Scrolling and viewport changes (such as the keyboard opening) reposition the suggestion instead of dismissing it.
- Mobile has its own debounce delay (default 1500 ms): typing and IME commits are slow on a phone, so it waits longer after the punctuation before requesting. Pending requests are cancelled when the app goes to the background.
- With a hardware keyboard, `Tab` and `Esc` still work.
- Mobile browsers apply CORS like desktop browsers. If requests fail with a CORS error, turn on [forwardProxy](#cors-and-forwardproxy).

## Setup

Settings → Marketplace → Downloaded → Ghost Writer → ⚙:

| Setting | Notes |
|---|---|
| API format | Default "Auto", see [API format](#api-format) and [API auto-detection rules](#api-auto-detection-rules). Can also be fixed to Gemini native or OpenAI compatible |
| API base URL | E.g. `https://api.deepseek.com/v1` or `https://generativelanguage.googleapis.com/v1beta`. Must start with `http://` or `https://`. A pasted `/chat/completions` or `/models/…:generateContent` suffix is removed. If the URL is invalid, an error is shown and the previous value is kept. Default: `https://api.deepseek.com` |
| API key | Required. Without a key no request is ever made. Local servers that need no key (Ollama, LM Studio, …) still need a dummy value such as `local`. |
| Model | Default: `deepseek-flash` |
| Debounce delay (ms) | 100–60000, default 400 |
| Debounce delay on mobile (ms) | Used in SiYuan's mobile interface. 100–60000, default 1500 |
| Mobile: tapping the ghost text accepts only up to the tapped clause | Default on. When off, a tap accepts the whole sentence |
| Max context characters | How much preceding text is sent (and, in revision mode, following text). 200–1000000, default 1500 |
| Trigger punctuation | Characters that trigger a prediction |
| Route via kernel forwardProxy | See [CORS and forwardProxy](#cors-and-forwardproxy) |
| Extra request body (JSON) | See [Extra request body](#extra-request-body) |
| Temperature | 0–2. Lower stays closer to your text, higher is more creative. Default 0.7 |
| System prompt / User message template for writing and revision mode | See [Custom prompts](#custom-prompts) |

For the number fields, an empty or invalid value falls back to the default, and out-of-range values are clamped.

### API format

| Option | Request | Key sent in |
|---|---|---|
| Auto (default) | Format and URL chosen by the [API auto-detection rules](#api-auto-detection-rules) below | the header of the format in use |
| Google Gemini native | `POST {base}/models/{model}:generateContent` | `x-goog-api-key` header |
| OpenAI compatible | `POST {base}/chat/completions` | `Authorization: Bearer` header |

With Gemini native or OpenAI compatible selected, only that format is requested, at the base URL as entered, with no probing.

### API auto-detection rules

With the format set to "Auto", the first request probes in this order and remembers the endpoint that works.

**1. Model name**

- The model name contains `gemini` or `gemma` (case-insensitive): probe the Gemini native API first (step 2).
- Any other model: use the OpenAI-compatible API directly, with no probing. Relays such as new-api also translate Gemini-format requests for GPT and other models, but in testing they dropped the system prompt and suggestions got much worse.

**2. Gemini native URLs to try**

Derived from the base URL you entered, tried in order, each at most once:

1. If the URL ends with `/openai` (Google AI Studio's OpenAI-compatible URL): without `/openai`;
2. If the URL ends with `/v1` (common on relays): with `/v1` changed to `/v1beta`;
3. If the URL has no version segment (such as `/v1` or `/v1beta`): with `/v1beta` appended;
4. The URL as entered.

Each is followed by `/models/{model}:generateContent`. For example, with the model `gemini-3.8-flash`:

| Base URL entered | Gemini native URLs tried, in order | OpenAI-compatible fallback |
|---|---|---|
| `https://ai.llc.moe/v1` | `https://ai.llc.moe/v1beta` → `https://ai.llc.moe/v1` | `https://ai.llc.moe/v1/chat/completions` |
| `https://generativelanguage.googleapis.com/v1beta/openai` | `…/v1beta` → `…/v1beta/openai` | `…/v1beta/openai/chat/completions` |
| `https://generativelanguage.googleapis.com/v1beta` | `…/v1beta` | `…/v1beta/chat/completions` |
| `https://api.example.com` | `https://api.example.com/v1beta` → `https://api.example.com` | `https://api.example.com/chat/completions` |

So you can keep entering the OpenAI-compatible base URL.

**3. When it moves on to the next URL**

| Situation | Action |
|---|---|
| Any HTTP error (including 400, 401, 404 and 429) | Next URL. Some relays answer a Google-style 400 for models that aren't on their Gemini route, so 400 is retried too |
| Response is not JSON, or not in Gemini format (no `candidates`) | Next URL |
| Network or CORS error on a direct connection | Next URL |
| Timeout, cancellation, or a kernel forwardProxy failure | Stop and show the error (another URL would only be slower) |
| The model answered but with only thinking, a cut-off output, or a safety block | Stop and show the reason (the endpoint works) |

If no Gemini URL works, the OpenAI-compatible format is requested at the base URL as entered.

**4. Which error is shown when everything fails**

The OpenAI-compatible error, by default. But if that is only a "no such endpoint" kind of error (404, 405, a non-Google-style error, a malformed response, a network error) and Gemini gave a clear reason (for example an invalid key or exhausted quota), the Gemini error is shown, so the real cause isn't hidden behind a 404.

**5. Remembering the result**

- The working format and URL are stored per base URL + model in the plugin data (up to 20 entries) and used directly afterwards, also after restarting SiYuan.
- Changing the base URL or model probes again.
- A stored endpoint that returns a "not supported" error (404, 405, malformed response, network error) is forgotten and probed again. A temporary rate limit (429) or server error (5xx) is only reported and keeps the stored format.
- The first probe may cost a few extra failed requests; after that each suggestion is a single request.

When Gemini native is detected, OpenAI-style fields in the extra request body are converted automatically; see [Extra request body](#extra-request-body).
### Extra request body

This field takes a JSON object that is merged into the request. It is mostly used to lower or turn off "thinking", which is slow and wastes tokens for one-sentence predictions.

- Parameters for both formats can live in the same object; each format takes only its own fields:
  - **Gemini native** takes top-level Gemini request fields such as `generationConfig` and `safetySettings`, merged object by object. For example `{"generationConfig":{"thinkingConfig":{"thinkingLevel":"low"}}}` leaves the temperature alone.
  - **OpenAI compatible** takes the other fields. It can override `temperature` and `max_tokens` (default 80), but not `model`, `messages` or `stream`.
- With Gemini native, OpenAI-style fields are carried over when `generationConfig` doesn't set the same thing: `reasoning_effort` becomes `thinkingConfig` (`thinkingBudget` on 2.5 models; none/minimal become low), and `max_tokens` becomes `maxOutputTokens` (default 1024). Settings written for Gemini's OpenAI-compatible endpoint keep working.
- It must be a JSON object. If it isn't, saving shows an error and keeps the previous value.

| Provider | Extra request body |
|---|---|
| DeepSeek / Zhipu | `{"thinking":{"type":"disabled"}}` (default) |
| Qwen (DashScope) | `{"enable_thinking":false}` |
| Gemini 3.x / 4.x (native or OpenAI compatible) | `{"reasoning_effort":"low","max_tokens":512}`, or natively `{"generationConfig":{"thinkingConfig":{"thinkingLevel":"low"}}}` |
| Gemini 2.5 Flash | `{"reasoning_effort":"none"}` |
| OpenAI and providers that reject unknown fields | leave empty |

**Gemini:** use `https://generativelanguage.googleapis.com/v1beta` or its OpenAI-compatible URL `…/v1beta/openai`; "Auto" switches to the native API either way. Gemini 3 and later cannot turn thinking off fully, and the output limit includes thinking tokens, so lower it, e.g. `{"generationConfig":{"thinkingConfig":{"thinkingLevel":"low"}}}` or the `{"reasoning_effort":"low"}` from the table (in testing, 3.8 Flash took about 11 s per sentence at its default thinking level and about 2 s at low). If the model returns only thinking or the output is cut off, Ghost Writer suggests lowering thinking or raising the output limit; a safety block is reported with its reason.

### CORS and forwardProxy

By default the request is sent directly from SiYuan's frontend. If your browser blocks it because of CORS, turn on "Route via kernel forwardProxy". This is common when SiYuan runs in Docker and you open it in a browser. The request is then sent by the SiYuan kernel through `/api/network/forwardProxy`.

- With SafeMode on, the kernel forwardProxy refuses loopback and private-network addresses. For a local LLM (`http://127.0.0.1:11434/v1`, `http://192.168.x.x…`), keep forwardProxy **off** and use the direct mode.
- Requests time out after 15 seconds in both modes.

### Error messages

Failed predictions are shown as error toasts, for example:

- an HTTP status with the server's message
- a forwardProxy failure
- a timeout
- a response that is not JSON (usually a wrong base URL)
- a model that returned no text

The API key is masked as `***`, long messages are shortened, and the same message is shown at most once per minute.

## Custom prompts

Writing mode and revision mode each have their own prompts, edited separately in settings.

**Default prompts follow SiYuan's interface language:** Chinese (Simplified or Traditional) uses the Chinese defaults; every other language uses the English defaults (which limit suggestions to "about 30 words"). Prompts you have customised are always used as written, whatever the interface language.


- **System prompt:** the model's role and output rules, such as style, length and language. The default writing prompt asks for "the next sentence"; the default revision prompt asks for "one sentence to insert at ▍ that bridges the text before and after".
- **User message template:** you can use these variables (full-width `｛｛ ｝｝` braces also work):
  - `{{title}}`: the document title
  - `{{before}}`: the preceding text
  - `{{current}}`: the current paragraph up to the caret
  - `{{currentAfter}}`: the current paragraph after the caret (revision mode only)
  - `{{after}}`: the following text (revision mode only)

  The default revision template marks the insertion point as `{{current}}▍{{currentAfter}}`. When the document has no title, any line whose only variable is `{{title}}` is removed. If the template doesn't contain `{{current}}`, the current paragraph is appended at the end.
- **Temperature:** see the table above; shared by both modes.

All four text areas have a "Restore default" button, which fills in the default for the current interface language. Saving one empty, or with exactly the Chinese or English default text, stores "use default", so you get improvements to the built-in prompts, and the right language after switching the interface language, automatically.

## Privacy

- **What is sent:** when a prediction is triggered, Ghost Writer sends the following to the LLM service you configured:
  - the document title
  - the text of the blocks before the current one that are loaded in the editor, up to "Max context characters" (default 1500)
  - the current paragraph up to the caret
  - in revision mode also: the rest of the paragraph after the caret, and the text of the following blocks loaded in the editor (also up to "Max context characters")

  Only connect to services you trust.
- **When requests are made:** only when the global switch is on, the current document is in writing or revision mode and an API key is set. With forwardProxy on, the request is sent from the machine running the SiYuan kernel.
- **What is stored:**
  - The settings, including the API key in plain text, are stored in `data/storage/petal/siyuan-plugin-ghostwriter/config.json`.
  - Each document's mode (document ID → writing / revision) is stored in `docs.json` next to it.
  - Both files are synced with your workspace.
- Ghost Writer has no telemetry and no other network access.

## Development

```bash
npm i
# optional: build straight into a SiYuan workspace (this file is git-ignored)
echo "SIYUAN_PLUGIN_DIR=<workspace>/data/plugins/siyuan-plugin-ghostwriter" > .env.local
npm run dev        # watch build into SIYUAN_PLUGIN_DIR (or dist/ if unset)
npm run build      # one-off build into SIYUAN_PLUGIN_DIR (or dist/)
npm run typecheck  # tsc --noEmit
npm run package    # clean build into dist/ and create package.zip for a release
```

## License

MIT

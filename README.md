# Ghost Writer

When you type sentence punctuation, Ghost Writer asks an OpenAI-compatible LLM for your most likely next sentence and shows it as grey ghost text after the caret. Press `Tab` to accept it.

> **Every document is off by default.** After setting an API key, turn Ghost Writer on for each document you want it in (see below). Until you do, nothing happens and no request is sent.

## Usage

### Turning it on

- **Per document (default off):** use any of these. The choice is remembered per document.
  - the ghost button in the editor breadcrumb bar (highlighted when on)
  - the document title icon menu → "Ghost Writer: on/off for this document"
  - the command "Ghost Writer: toggle for this document", which has no default shortcut. You can bind one in Settings → Keymap, in the plugin section.
- **Global switch:** `Alt+Shift+G` (or "Enabled" in the plugin settings). This turns predictions on or off everywhere without changing the per-document choices.

### Writing with suggestions

- A prediction is requested after you type one of the trigger punctuation marks (default `，。！？；：,.!?;:`) and pause for the debounce delay (default 400 ms).
- It is only requested when all of these hold:
  - the caret is at the end of the block
  - you are not composing with an IME
  - the editor is not read-only
- No predictions in code, math, HTML, table, database, iframe, widget, video or audio blocks, or inside embed blocks.
- `Tab` accepts the suggestion. Ghost Writer then predicts the following sentence straight away, so you can keep pressing `Tab` to keep writing.
- `Esc` dismisses it. Typing, clicking, moving the caret, scrolling or leaving the editor also dismisses it.
- `Tab` and `Esc` are left to SiYuan while its hint menu is open (`/`, `[[`, `((`, `:` and similar). No predictions are requested then either.
- While a suggestion is showing, `Tab` accepts it instead of indenting a list item. `Shift+Tab` and `Ctrl+Tab` are never intercepted.
- The ghost text is an overlay. It never touches the document or the undo stack until you accept it.
- Accepted text is inserted literally. Markdown characters such as `*`, `$` or `((` are escaped, so they render as plain text. In a raw Markdown export they appear with a backslash.
- Desktop only (desktop app, desktop windows and desktop browser). The plugin is not loaded on mobile or on publish-service pages.

## Setup

Settings → Marketplace → Downloaded → Ghost Writer → ⚙:

| Setting | Notes |
|---|---|
| API base URL | OpenAI-compatible base URL, e.g. `https://api.deepseek.com/v1`. Must start with `http://` or `https://`. A pasted `/chat/completions` suffix is removed. If the URL is invalid, an error is shown and the previous value is kept. Default: `https://api.deepseek.com` |
| API key | Required. Without a key no request is ever made. Local servers that need no key (Ollama, LM Studio, …) still need a dummy value such as `local`. |
| Model | Default: `deepseek-flash` |
| Debounce delay (ms) | 100–60000, default 400 |
| Max context characters | How much preceding text is sent. 200–1000000, default 1500 |
| Trigger punctuation | Characters that trigger a prediction |
| Route via kernel forwardProxy | See [CORS and forwardProxy](#cors-and-forwardproxy) |
| Extra request body (JSON) | See [Extra request body](#extra-request-body) |
| Temperature | 0–2. Lower stays closer to your text, higher is more creative. Default 0.7 |
| System prompt / User message template | See [Custom prompts](#custom-prompts) |

For the number fields, an empty or invalid value falls back to the default, and out-of-range values are clamped.

### Extra request body

This field takes a JSON object that is merged into the chat-completions request. It is mostly used to turn off "thinking", which is slow and wastes tokens for one-sentence predictions.

- It can override `temperature` and `max_tokens` (default 80), but not `model`, `messages` or `stream`.
- It must be a JSON object. If it isn't, saving shows an error and keeps the previous value.

| Provider | Extra request body |
|---|---|
| DeepSeek / Zhipu | `{"thinking":{"type":"disabled"}}` (default) |
| Qwen (DashScope) | `{"enable_thinking":false}` |
| Gemini 3.x Flash | `{"reasoning_effort":"minimal","max_tokens":512}` (3.8 Flash accepts `"low"` at minimum) |
| Gemini 2.5 Flash | `{"reasoning_effort":"none"}` |
| OpenAI and providers that reject unknown fields | leave empty |

**Gemini:** use the base URL `https://generativelanguage.googleapis.com/v1beta/openai`. Gemini counts thinking tokens against `max_tokens`, so the default of 80 can be used up before any text is produced. Add `"max_tokens":512` as in the example above. If the model returns only reasoning, or the output is cut off, Ghost Writer shows a hint to disable thinking or raise `max_tokens`.

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

You can edit these in settings:

- **System prompt:** the model's role and output rules, such as style, length and language.
- **User message template:** you can use these variables (full-width `｛｛ ｝｝` braces also work):
  - `{{title}}`: the document title
  - `{{before}}`: the preceding text
  - `{{current}}`: the current paragraph up to the caret

  When the document has no title, any line whose only variable is `{{title}}` is removed. If the template doesn't contain `{{current}}`, the current paragraph is appended at the end.
- **Temperature:** see the table above.

Both text areas have a "Restore default" button. Saving one empty, or with exactly the default text, stores "use default", so you get improvements to the built-in prompts automatically.

## Privacy

- **What is sent:** when a prediction is triggered, Ghost Writer sends three things to the LLM service you configured:
  - the document title
  - the text of the blocks before the current one that are loaded in the editor, up to "Max context characters" (default 1500)
  - the current paragraph up to the caret

  Only connect to services you trust.
- **When requests are made:** only when the global switch is on, the current document is switched on and an API key is set. With forwardProxy on, the request is sent from the machine running the SiYuan kernel.
- **What is stored:**
  - The settings, including the API key in plain text, are stored in `data/storage/petal/siyuan-plugin-ghostwriter/config.json`.
  - The IDs of documents you switched on are stored in `docs.json` next to it.
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

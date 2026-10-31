# Wiki AI

A browser extension (Chrome and Safari) that adds a chat sidebar to Wikipedia articles. You can ask about the article you're reading and the articles it links to. It runs on your own models through the LiteLLM gateway on the tailnet (any OpenAI-compatible endpoint works).

## What it does

- **Answers from the article, with citations.** Every claim gets a numbered source. Click one: if it's from the current article, the passage is highlighted in the page and scrolled into view. If it's from a linked article, a preview opens with a link that jumps to the passage.
- **Follows links.** The model can find relevant linked articles (by their title, link text and the sentence they appear in), read their introductions, and search inside them.
- **Ask about selected text.** Select a passage and click **Ask about this**, or right-click → *Ask Wiki AI about "…"*.
- **Knows where you are.** The section you're scrolled to is added to the prompt, so "explain this section" works.
- **Falls back automatically.** If the PC model is off (HTTP 503), it retries on `mac/qwen3.5-9b-fast`.

Toggle the sidebar with the round button (bottom right), the toolbar icon, or **Alt+Shift+W**.

## How it works

```
content/content.js   sidebar (shadow DOM), link + context extraction from the page DOM,
                     citation highlighting (CSS Custom Highlight API), selection button
background/          service worker: runs the agent per question over a runtime port
lib/wiki.js          Wikipedia API: plain-text article split into sections → ~160-word chunks,
                     REST summaries; cached 24 h in IndexedDB
lib/bm25.js          keyword search over chunks and over links (no embedding model needed)
lib/agent.js         tool-calling loop, prompt budget, numbered sources
lib/llm.js           streaming OpenAI-compatible client (tool calls, <think> handling, 503 fallback)
```

Context stays small because the model pulls in text through tools rather than getting the whole article:

| Always in the prompt | Fetched by tools when needed |
|---|---|
| Article outline and introduction | `search_article`, `read_section` |
| The section you're reading | `find_linked_articles` |
| Your selected text | `linked_article_summary` |
| Top passages and candidate links for the question, found automatically | `search_linked_article` |

Prompt budgets per model are in `lib/settings.js` (`contextFor`): 48k tokens for the PC model, 12k for the Mac 9B (it reads ~210 tok/s, so bigger prompts get slow).

## Install

### Chrome
1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick this folder.
2. Open the extension's **Options**, paste your gateway key (`LITELLM_MASTER_KEY`), click **Test connection**, then **Save**.

### Safari
```bash
xcrun safari-web-extension-converter . --project-location ../wiki-ai-safari --app-name "Wiki AI" --macos-only
```
Open the generated Xcode project, choose your Apple ID team under *Signing & Capabilities*, and run it. Then enable it in Safari → Settings → Extensions and allow it on wikipedia.org. Requires Safari 17.4+.

The device must be on the tailnet. The key is stored only in the browser's extension storage.

## Testing

**Agent against the real model, from the terminal:**
```bash
set -a; . ~/.config/local-llm/env; set +a
node test/agent-cli.mjs "Ada Lovelace" "Who was her mother and what was she known for?" mac/qwen3.5-9b
```

**Sidebar UI without installing the extension** (real Wikipedia retrieval, scripted fake model, no key):
```bash
mkdir -p test/fixtures && curl -s https://en.wikipedia.org/wiki/Ada_Lovelace | sed 's|<head>|<head><base href="https://en.wikipedia.org/">|; s|</body>|<script src="http://127.0.0.1:8765/test/harness.js"></script></body>|' > test/fixtures/ada.html
python3 -m http.server 8765 --bind 127.0.0.1
```
Then open http://127.0.0.1:8765/test/fixtures/ada.html.

## Known limits

- Small models (the Mac 9B) sometimes answer from the introduction instead of opening a linked article. The PC model follows links more reliably.
- Highlighting finds passages by matching text. Passages with math or heavy templates fall back to scrolling to the section heading.
- English stopwords only. Other-language Wikipedias work, with slightly noisier keyword search.

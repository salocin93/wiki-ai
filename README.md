# Wiki AI

A browser extension (Chrome and Safari) that adds a chat sidebar to Wikipedia articles. You can ask about the article you're reading and the articles it links to. It runs on your own models through the LiteLLM gateway on the tailnet (any OpenAI-compatible endpoint works).

## What it does

- **Answers from the article, with citations.** Every claim gets a numbered source. Click one: if it's from the current article, the passage is highlighted in the page and scrolled into view. If it's from a linked article, a preview opens with a link that jumps to the passage.
- **Follows links.** The model can find relevant linked articles (by their title, link text and the sentence they appear in), read their introductions, and search inside them.
- **Ask about selected text.** Select a passage and click **Ask about this**, or right-click → *Ask Wiki AI about "…"*.
- **Knows where you are.** The section you're scrolled to is added to the prompt, so "explain this section" works.
- **Topic clusters across many articles.** Click **Build topic cluster** and the model groups the article's most relevant links into themes, e.g. *House of Oldenburg* → Danish line, cadet branches, origins. The cluster stays active as you browse its articles, and questions then search every article in it at once. You can add or remove articles, and switch between saved topics.
- **Three sections: Chat, Topic, Map.**
  - **Chat**: the conversation, with **History** (saved chats for this topic or article: reopen or delete) and **New chat**.
  - **Topic**: the active topic's themes and articles, saved topics, and **Questions to explore**.
  - **Map**: the topic's articles as a graph (colored by theme, sized by connections, lines for links). Click an article for its summary, open it, or ask about it; enlarge the map over the article area.
- **Suggested next questions.** Every answer ends with three follow-up questions. Clicking one continues the same chat; asked ones get a ✓. Suggestions you haven't asked yet, from all your chats, collect under **Topic › Questions to explore**, and asking one there continues the chat it came from.
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
lib/cluster.js       builds a topic cluster: rank links → model groups them into themes → check titles
lib/topics.js        saved topics, search across a topic's articles, message API for the sidebar
```

### How a topic cluster is built

1. **Candidates, no model:** every link on the page is scored by where it appears: navigation boxes (a topic's member list), "Main article:" notes, the infobox, the introduction, and how often it is linked. The top 80 are kept.
2. **One model call:** the model gets the introduction, the outline and the numbered candidates, and returns themes as lists of candidate **numbers**, so it can't invent article titles. For a missing theme it can suggest a Wikipedia search instead.
3. **Check, no model:** every title is resolved through the Wikipedia API (redirects followed, missing articles dropped). Then each article's one-line description is fetched, and the links between the topic's articles are mapped.

With a topic active, the model gets the topic map (themes, articles, descriptions) and two extra tools: `search_topic` (one search across all topic articles, at most two passages per article so no single article dominates) and `topic_connections` (how one article links to the others, with the citable sentences).

### Storage

| What | Where | Size and lifetime |
|---|---|---|
| Saved topics (titles, themes, short summaries, links between pages) | `chrome.storage.local` | ~20–60 KB per topic, kept until you delete it |
| Wikipedia article text and summaries | IndexedDB cache | expires after 24 h, capped at 300 entries (oldest removed first) |
| Saved chats (messages, sources trimmed to 700 characters) | `chrome.storage.local` | 12 per topic or article, 40 topics/articles at most (least recently used dropped) |
| Search indexes | memory only | rebuilt as needed |

The settings page shows current usage and has a button to clear the cache.

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

**Topic cluster against the real model** (link signals are approximated from the HTML):
```bash
node test/cluster-cli.mjs "House of Oldenburg" mac/qwen3.5-9b "How is the House of Oldenburg connected to Denmark, Greece and Russia?"
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

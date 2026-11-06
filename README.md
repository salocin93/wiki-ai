<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="icons/logo-dark.svg">
    <img src="icons/logo.svg" alt="Wiki AI" width="240">
  </picture>
</p>

# Wiki AI

> Wiki AI is an independent project. It is not affiliated with, endorsed by or sponsored by Wikipedia or the Wikimedia Foundation. Wikipedia is a trademark of the Wikimedia Foundation.

A browser extension (Chrome and Safari) that adds a chat sidebar to Wikipedia articles. You can ask about the article you're reading and the articles it links to. It works with Google Gemini (free API key) or any OpenAI-compatible endpoint, including models you run yourself.

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
- **Questions that fit the article.** The questions an empty chat suggests depend on what the article is about: a person (what they're known for, turning points, legacy), an event (causes, consequences), a work (how it came about, how it was received), a place, a group, a religion or a concept. The type comes from Wikidata. A question is only offered if the article has a section that can answer it. Topics get questions that fit their kind, such as "How did these people influence each other?" for a topic about people.
- **Suggested next questions.** Every answer ends with three follow-up questions. Clicking one continues the same chat; asked ones get a ✓. Suggestions you haven't asked yet, from all your chats, collect under **Topic › Questions to explore**, and asking one there continues the chat it came from.
- **Checked against its sources.** Before an answer is shown, each claim is compared with the passages it cites. Claims they don't back are sent back to the model once to fix, and whatever still isn't backed is left out; a collapsed note under the answer lists what was left out and why. With **Check citations with the model** on (Settings › Answers), the model itself judges each cited sentence, which is more accurate but adds a request per answer (its timing is in the answer's debug info).
- **Falls back automatically.** If the main model is unavailable or rate-limited, it retries on the fallback model set in the settings.

The sidebar opens on every Wikipedia article. Close it with × (it stays closed in that tab) and reopen it with the round button (bottom right), the toolbar icon, or **Alt+Shift+W**.

## How it works

```
content/content.js      sidebar (shadow DOM): chat, topic, map and history views, selection button
content/page.js         the article on screen: links and their context, sections, finding and
                        highlighting a cited passage (CSS Custom Highlight API), links back to Wikipedia
content/markdown.js     escape-first Markdown for answers; KaTeX is loaded on the first formula
content/map.js          the topic map (no library)
content/phrases.js      starter questions in several languages, fitted to the article's type or topic's kind
background/             service worker: runs the agent per question over a runtime port, checks
                        who sends each message
options/                settings page (provider, key, answer language, storage)
lib/wiki.js             Wikipedia API: plain-text article split into sections → ~160-word chunks,
                        plus its tables, infobox and images (with Wikimedia Commons details);
                        REST summaries; cached 24 h in IndexedDB
lib/tables.js           tables, infoboxes and images from the article HTML as text (the extract drops them)
lib/sections.js         names of reference and "See also" sections in many languages
lib/types.js            what kind of subject an article is (person, place, event …) and facts about it, from Wikidata
lib/bm25.js             keyword search over chunks and over links (no embedding model needed)
lib/embeddings.js       optional semantic search: passage embeddings (Gemini or a local model) fused with BM25;
                        see docs/SEMANTIC_SEARCH.md
lib/links.js            how central each linked article is (navigation boxes, infobox, introduction …)
lib/agent.js            tool-calling loop, prompt budget, numbered sources
lib/prompt.js           the agent's system prompt, one entry per rule
lib/grounding.js        checks each sentence's details against the passages it cites
lib/llm.js              streaming OpenAI-compatible client (tool calls, <think> handling, 503 fallback)
lib/cluster.js          builds a topic cluster: rank links → model groups them into themes → check titles
lib/topics.js           saved topics, search across a topic's articles, message API for the sidebar
lib/conversations.js    saved chats, with size limits
lib/storage.js          extension storage with one write at a time per key
lib/cache.js            the article cache (IndexedDB): 24 h for articles, 7 days for embedding vectors
lib/settings.js         settings, endpoint rules, token estimates
lib/text.js             helpers shared by the worker, panel and settings (escaping, citations, URLs)
types/                  shared record types for the type check
scripts/build.mjs       esbuild: bundles the ES modules into dist/wiki-ai/ (build, watch, release)
scripts/package.sh      zips a release build for testers or the Chrome Web Store
```

### How a topic cluster is built

1. **Candidates, no model:** every link on the page is scored by where it appears: navigation boxes (a topic's member list), "Main article:" notes, the infobox, the introduction, and how often it is linked. The top 80 are kept.
2. **One model call:** the model gets the introduction, the outline and the numbered candidates, and returns themes as lists of candidate **numbers**, so it can't invent article titles. For a missing theme it can suggest a Wikipedia search instead.
3. **Check, no model:** every title is resolved through the Wikipedia API (redirects followed, missing articles dropped). Then each article's one-line description is fetched, and the links between the topic's articles are mapped.

With a topic active, the model gets the topic map (themes, articles, descriptions) and two extra tools: `search_topic` (one search across all topic articles, at most two passages per article so no single article dominates) and `topic_connections` (how one article links to the others, with the citable sentences).

### Storage

| What | Where | Size and lifetime |
|---|---|---|
| Saved topics (titles, themes, short summaries, links between pages) | `chrome.storage.local` | ~20–60 KB per topic, kept until you delete it; 50 at most (least recently changed dropped, with their chats) |
| Wikipedia article text and summaries | IndexedDB cache | expires after 24 h, capped at 300 entries (oldest removed first) |
| Section embeddings (only with the experimental Semantic search setting) | IndexedDB cache | expires after 7 days, counted in the same 300 entries |
| Saved chats (messages; cited sources trimmed to 700 characters, uncited ones without text) | `chrome.storage.local` | 12 per topic or article, 40 topics/articles at most, and storage kept under 8 MB (least recently used dropped) |
| Search indexes | memory only | rebuilt as needed |

The settings page shows current usage and has a button to clear the cache.

Context stays small because the model pulls in text through tools rather than getting the whole article:

| Always in the prompt | Fetched by tools when needed |
|---|---|
| Article outline and introduction | `search_article`, `read_section` |
| The section you're reading | `find_linked_articles` |
| Your selected text | `linked_article_summary` |
| Top passages and candidate links for the question, found automatically | `search_linked_article` |

Prompt budgets per model are in `lib/settings.js` (`contextFor`): 32k tokens for Gemini, 16k otherwise. Set **Context tokens** in the settings to use more with a model that reads fast.

## Install

### Chrome
1. Build it (Node 20 or later):
   ```bash
   npm install
   npm run build      # or: npm run watch, to rebuild on every save
   ```
   This writes the extension to `dist/wiki-ai/`. The sources are ES modules, which esbuild bundles into one script each for the service worker, the sidebar and the settings page (not minified, with source maps in development builds).
2. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick `dist/wiki-ai/`. After a rebuild, press the extension's reload button (and reload the Wikipedia tab). The folder stays the same whatever the version number, so you only load it once.
3. Open the extension's **Options** and pick where answers come from:
   - **Google Gemini**: paste a free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
   - **Other provider**: enter the endpoint address and key under **Advanced connection**.
4. Click **Test connection** (for your own server, allow Wiki AI to reach it when the browser asks), then **Save**.

### Safari
```bash
npm run build
xcrun safari-web-extension-converter dist/wiki-ai --project-location ../wiki-ai-safari --app-name "Wiki AI" --macos-only
```
Open the generated Xcode project, choose your Apple ID team under *Signing & Capabilities*, and run it. Then enable it in Safari → Settings → Extensions and allow it on wikipedia.org. Requires Safari 17.4+.

The key is stored only in the browser's extension storage. Plain `http://` endpoints are accepted only on this computer or the local network.

### Packages
```bash
npm run package          # dist/wiki-ai-<version>.zip, for testers (one wiki-ai folder, with docs/TESTING.md)
npm run package:store    # dist/wiki-ai-<version>-store.zip, for the Chrome Web Store (manifest at the root)
```
Each makes a release build (no source maps) in a temporary folder, so `dist/wiki-ai/` and a running `npm run watch` are left alone. Older zips stay in `dist/`. The listing text and submission steps are in [docs/STORE_LISTING.md](docs/STORE_LISTING.md); the privacy policy is [PRIVACY.md](PRIVACY.md).

## Testing

**Unit tests, lint, types and build** (no network, no model; also run on every push by GitHub Actions):
```bash
npm install
npm test
npm run lint
npm run typecheck   # JSDoc types across the modules, with the shared records in types/
npm run build
```

**Agent against the real model, from the terminal:**
```bash
export LLM_API_KEY=…                       # a Gemini key, or your endpoint's key
export LLM_BASE_URL=https://…/v1           # leave unset for Gemini
node test/agent-cli.mjs "Ada Lovelace" "Who was her mother and what was she known for?" [model]
```

It prints each source check (`[grounding]`): numbers and names in the answer that aren't in any source the model read.

**Source check on known answers** (no model needed):
```bash
node test/grounding-check.mjs
```

**Tables, infoboxes and images read from article HTML** (no model needed):
```bash
node test/tables-check.mjs
```

**Topic cluster against the real model** (link signals are approximated from the HTML):
```bash
node test/cluster-cli.mjs "House of Oldenburg" [model] "How is the House of Oldenburg connected to Denmark, Greece and Russia?"
```

**Sidebar UI without installing the extension** (real Wikipedia retrieval, scripted fake model, no key):
```bash
mkdir -p test/fixtures && curl -s https://en.wikipedia.org/wiki/Ada_Lovelace | sed 's|<head>|<head><base href="https://en.wikipedia.org/">|; s|</body>|<script src="http://127.0.0.1:8765/dist/harness.js"></script></body>|' > test/fixtures/ada.html
npm run build            # also bundles the harness to dist/harness.js
python3 -m http.server 8765 --bind 127.0.0.1
```
Then open http://127.0.0.1:8765/test/fixtures/ada.html. With `npm run watch` running, a page reload picks up your changes.

## Known limits

- Small models sometimes answer from the introduction instead of opening a linked article. Larger models follow links more reliably.
- Highlighting finds passages by matching text. Passages with math or heavy templates fall back to scrolling to the section heading.
- English stopwords only. Other-language Wikipedias work, with slightly noisier keyword search.

## Documentation

| File | What it is |
|---|---|
| [PRIVACY.md](PRIVACY.md) | The privacy policy. The extension links to it, so it stays at this path |
| [docs/TESTING.md](docs/TESTING.md) | Guide for testers; it goes into the tester zip |
| [docs/STORE_LISTING.md](docs/STORE_LISTING.md) | Chrome Web Store listing text, dashboard answers and submission steps |
| [docs/review/REPORT.md](docs/review/REPORT.md) | Final report of the pre-publication review: what was fixed, in which pull request, and what's left |
| [docs/review/](docs/review/) | The review itself (2026-11-03, of commit `db7f2d6`): code review, security, store readiness, action plan and architecture as they were then |

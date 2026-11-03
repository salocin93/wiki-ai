# Chrome Web Store listing: draft

Text to paste into the developer dashboard. Fill in `<CONTACT EMAIL>` and check the privacy policy URL before you submit.

## Name
Wiki AI

## Summary (≤ 132 characters)
Chat with an AI model about the Wikipedia article you're reading and the articles it links to.

## Category
Tools (or Education)

## Description

Ask questions about the Wikipedia article you're reading and get answers with numbered sources. Click a source to jump to the passage in the article.

**You need an API key.** Wiki AI works with Google's Gemini API (a free key from aistudio.google.com) or any OpenAI-compatible service, including a model you run on your own computer. Your questions, any text you select, earlier questions in the chat and passages from Wikipedia are sent to the service you choose, to write the answer. On Gemini's free tier, Google may use them to improve its products.

What it does:
• Answers from the article, with a numbered source for each claim; claims it couldn't match to Wikipedia are underlined.
• Opens linked articles itself when the current one only mentions something briefly.
• "Ask about this" on selected text, or right-click › Ask Wiki AI.
• Topic clusters: groups an article's most relevant links into themes so you can ask across many articles at once, and shows them as a map.
• Suggested follow-up questions, and a history of your chats.

Privacy: the developer runs no servers and receives none of your data. Chats and topics are stored only in your browser, and you can delete them at any time. Details: <PRIVACY POLICY URL>

While the sidebar is open, Wiki AI makes room for it on the page: the article gets narrower, and Wikipedia's right-hand tools column moves into its menus.

Wikipedia text is available under CC BY-SA 4.0; each answer links to the articles it quotes. Wiki AI is an independent project, not affiliated with, endorsed by or sponsored by Wikipedia or the Wikimedia Foundation.

## Single purpose (dashboard field)
Answer the reader's questions about the Wikipedia article they are reading, using that article and the Wikipedia articles it links to.

## Permission justifications (dashboard fields)
- **storage:** Saves the user's settings (AI provider, API key), their chats and topic clusters locally.
- **contextMenus:** Adds "Ask Wiki AI about …" for text selected on a Wikipedia article.
- **Host `https://*.wikipedia.org/*`:** Shows the sidebar on Wikipedia articles and reads Wikipedia articles through the Wikipedia API to answer questions.
- **Host `https://generativelanguage.googleapis.com/*`:** Sends the user's question to Google's Gemini API, the default AI provider, with the user's own API key.
- **Optional hosts `https://*/*`, `http://*/*`:** Requested at runtime, only for the one address the user enters as their own AI provider (for example a local model server), when they click Test connection. Plain http is accepted only for this computer and the local network.
- **Remote code:** None. All code, including the KaTeX math renderer, is in the package.

## Privacy practices tab
- Data collected: **Website content** (Wikipedia passages) and **user-generated content** (questions, selected text, chat history), sent to the user's chosen AI provider. If the dashboard offers "Personal communications", it doesn't apply: the questions aren't messages to other people.
- Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used for creditworthiness or lending.
- Privacy policy URL: the hosted copy of `PRIVACY.md`.

## Assets to prepare
- Icon 128×128: `icons/icon-128.png`
- At least one screenshot, 1280×800 or 640×400: the sidebar answering with sources; the topic map; the settings page.
- Small promo tile 440×280.
- Support: the GitHub issues URL, or an email address.

## Build
```bash
scripts/package.sh --store
```
Upload `dist/wiki-ai-<version>-store.zip`. Bump `version` in `manifest.json` before each upload.

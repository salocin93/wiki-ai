# Wiki AI: security and privacy

Commit `db7f2d6`, version 0.3.0. These are the security and privacy findings from `CODE_REVIEW.md` (same IDs), plus a threat model. Severity and status are defined in `CODE_REVIEW.md`.

## Threat model

| Adversary | What they control | What they could try | What stops them today | Gaps |
|---|---|---|---|---|
| **Untrusted web page** (any site) | Its own origin | Message the extension, read its data | No `externally_connectable` or `onMessageExternal`; the content script only runs on `*.wikipedia.org/wiki/*`; storage is extension-origin | None found |
| **Script on a Wikipedia page** (site JS, gadgets, CentralNotice, a user's `common.js`, a compromised renderer) | The page's main world and DOM | Read or alter the sidebar; feed crafted text into extraction; detect the extension | Isolated world for the content script; the API key is never sent to the content script (`getSettings` returns `hasKey` only) | The shadow root is `open`, so page script can read and alter chats (S-2). `web_accessible_resources` lets it detect the extension. A compromised renderer can use the content script's `chrome.storage.local` access to read the key (S-5), and send any `topics:`/`conv:`/`data:` message (S-4) |
| **Untrusted article text** (anyone can edit Wikipedia) | Article prose, tables, captions, link contexts, the visible-section text | Prompt injection: change answers, invent claims cited to real sources, cause many tool calls | Tools are read-only Wikipedia lookups; model output can't render links or images, so there's no exfiltration channel; the source check flags numbers and names missing from the sources | Article text sits in the system prompt with no delimiters or "treat as data" rule (S-1). The source check doesn't verify that the cited passage supports the claim (C-1 in `CODE_REVIEW.md`) |
| **Untrusted AI output** (a compromised, malicious or confused endpoint) | Answer text, tool calls, JSON for topics | XSS in the sidebar; javascript: links; runaway tool loops; fake citations | Escape-first Markdown with a fixed tag set; KaTeX `trust: false`; citation numbers filtered to known sources; topic pages chosen by number and checked against Wikipedia | No hard cap on tool rounds (A-1). Private-use placeholder characters aren't stripped (harmless markup) |
| **Attacker with the extension package** (anyone can unzip a CRX) | All shipped code | Extract bundled secrets | No key is bundled: the user supplies their own; `.env` is git-ignored, never committed, and not in the zips | None found. Keep `.env` out of every package (`scripts/package.sh` copies only named folders, which is correct) |
| **Network attacker** | Plain-HTTP traffic | Steal the API key and prompts | Gemini and Wikipedia are HTTPS-only | A custom endpoint can be `http://` on any host, and the key is sent as Bearer (S-3, M-2) |
| **Local user / malware on the profile** | Disk | Read the key and chat history | Out of scope for an extension | Key and chats are plaintext in `chrome.storage.local`. Disclose this in the privacy policy |

## Findings

| ID | Severity | Status | Location | Summary |
|---|---|---|---|---|
| P-1 | **Critical** (store) | Confirmed | whole extension | No privacy policy or data disclosure. Every question sends article text, the question, selected text and the full chat history to Google (default) or the configured endpoint. On Gemini's free tier, Google may use this data for training. That's only mentioned in the options page help and `TESTING.md`. See `STORE_READINESS.md` |
| S-1 | Medium | Confirmed | `lib/agent.js:340-400`, 494-501 | Untrusted article text in the system prompt with no delimiters or data-only rule |
| S-3 | Medium | Confirmed | `lib/llm.js:23-27`, 44-50; `options/options.js:202-209` | API key sent over plain HTTP to non-local custom endpoints |
| M-1 | Medium | Confirmed | `manifest.json:15-24` | `localhost`/`127.0.0.1` are required host permissions; they should be optional |
| M-2 | Medium | Confirmed | `manifest.json:20-23`, `options/options.js:243-256` | Optional `http://*/*` lets any plain-HTTP host be granted |
| H-2 | Medium | Confirmed | `lib/topics.js:41-46` | Deleting a topic leaves its chats in storage, unreachable from the UI. Incomplete deletion |
| L-3 | High (data loss) | Confirmed | `lib/topics.js:23-29`, `lib/conversations.js`, `content/content.js:901-903` | Unbounded storage growth, and silent save failures at the 10 MB quota |
| S-2 | Low | Confirmed | `content/content.js:330` | Open shadow root; page scripts can read and modify chats |
| S-4 | Low | Confirmed | `background/background.js:79-92` | No sender or shape validation on `onMessage` |
| S-5 | Low | Confirmed | `lib/settings.js:37-56`, `content/content.js:486-501` | Plaintext key in a storage area that content scripts can read |
| S-6 | Low | Confirmed | `content/content.js:1351`, 1419, 1600 | `rel="noopener"` without `noreferrer`; API-sourced `href` not scheme-checked |
| L-5 | Low | Confirmed | `lib/topics.js:139-144` | "Delete all" and "Clear cache" don't clear the worker's in-memory copies |
| W-5 | Low | Confirmed | `content/content.js:396-400` | Hides Wikimedia fundraising and CentralNotice banners without disclosure |

Details and code-level fixes for each are in `CODE_REVIEW.md` under the same ID.

## Data inventory

| Data | Where it goes | Stored | User can delete |
|---|---|---|---|
| API key(s), per provider | Sent as `Authorization: Bearer` to the chosen endpoint only | `chrome.storage.local` `settings.apiKey` and `settings.apiKeys`, plaintext | By clearing the field; uninstalling. "Delete all topics and chats" keeps keys (stated) |
| Questions, answers, selected passages, research steps, follow-ups | The model endpoint (whole history each turn) | `conv:<scope>`; 12 chats per scope, 40 scopes | Per chat (×), all topic chats, or all chats (options). Chats of a deleted topic stay (H-2) |
| Article text, link contexts, visible section, categories | The model endpoint | Passages up to 700 characters per source in saved chats; articles in IndexedDB for 24 h | "Clear article cache"; per chat |
| Reading behavior: titles of articles visited with the panel open, topics built | Wikipedia (normal browsing); titles in scope keys | Scope keys `page:<lang>:<title>`, `conv:index`, topics, `handoff` (2 min) | With the chats and topics. `handoff` is never cleared but expires |
| Debug trace (question, model, tool calls, source snippets; no key) | Clipboard, only when the reader clicks "Copy debug info" | Memory only | n/a |
| Telemetry or analytics | None | | |

The developer runs no servers and receives no data. It still counts as handling user data for Chrome Web Store purposes, because the extension sends website content and user-entered text to a third party (Google) on the user's behalf.

## Secrets check
- `.env` in the working tree holds `LOCAL_API_KEY` and `GEMINI_API_KEY` (values not printed). Not tracked: `git log --all -- .env` is empty and `.gitignore:2` covers it. Not in `dist/wiki-ai-0.2.0.zip` or `dist/wiki-ai-0.3.0.zip`.
- No key-like strings (`AIza…`, `sk-…`, `Bearer …`) in tracked files or in the history patch text.
- If the Gemini key in `.env` was ever pasted into a shared tester build or a screenshot, rotate it at aistudio.google.com.

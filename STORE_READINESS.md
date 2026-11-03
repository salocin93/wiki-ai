# Wiki AI: Chrome Web Store readiness

Checked against the Chrome Web Store program policies (single purpose, permissions, remote code, user data and Limited Use, listing quality) for commit `db7f2d6`. Policy wording changes; re-read the current policy pages before submitting.

Legend: ❌ blocker (likely rejection) · ⚠️ likely reviewer question or a weak spot · ✅ ready.

## Blockers

| # | Item | Status | Evidence | What to do |
|---|---|---|---|---|
| 1 | **Privacy policy** | ❌ Missing | The extension sends website content (article text), user-entered text (questions, selections) and chat history to Google's Gemini API by default, or to a user-chosen endpoint (`lib/llm.js:44-50`) | Publish a policy at a stable URL and link it in the dashboard. Cover: what is sent and to whom; that the developer receives nothing; local storage of keys and chats; retention and deletion; Google's free-tier training use; the third-party endpoint |
| 2 | **Privacy practices tab: data disclosures** | ❌ Not prepared | Same data flow | Declare "Website content" and "User activity/communications" (the questions), or whatever categories the dashboard offers then. Certify Limited Use: data is used only to provide the feature, not sold, not used for ads, and not read by humans |
| 3 | **Disclosing the third-party AI provider** | ❌ Not in a user-facing listing | Only mentioned in `options/options.js:10` and `TESTING.md` | State in the listing's first lines: needs your own Gemini (or OpenAI-compatible) API key; questions and article text are sent to that provider |

## Probable reviewer questions

| # | Item | Status | Evidence | What to do |
|---|---|---|---|---|
| 4 | Permission justification: `http://localhost/*`, `http://127.0.0.1/*` (required) | ⚠️ | `manifest.json:18-19` | Move to `optional_host_permissions` (M-1). Otherwise explain "for users who run a local model" |
| 5 | Permission justification: optional `https://*/*`, `http://*/*` | ⚠️ | `manifest.json:20-23` | Justify as "only the endpoint the user enters, requested at runtime". Restrict `http` to loopback (M-2) |
| 6 | Permission justification: `generativelanguage.googleapis.com`, `*.wikipedia.org`, `storage`, `contextMenus` | ✅ with text | | One sentence each in the dashboard |
| 7 | Undisclosed changes to the host site: hiding Wikimedia fundraising and CentralNotice banners, unpinning Vector's tools column, adding page margin | ⚠️ | `content/content.js:394-403`, 447-466 | Disclose, or stop hiding banners (W-5) |
| 8 | Sidebar auto-opens on every article | ⚠️ (UX, not policy) | `content/content.js:1781-1796` | Fine if disclosed. Consider closed by default after the first run |
| 9 | Name and branding vs. Wikipedia trademarks | ⚠️ | Name "Wiki AI", original globe mascot (not the Wikipedia puzzle globe) | Keep the README disclaimer in the listing ("not affiliated with the Wikimedia Foundation"). Don't use Wikipedia's logo or name as the brand. "Wiki" is generic |
| 10 | Content attribution (CC BY-SA) | ⚠️ | Verbatim passages in previews, no licence line (W-4) | Add the attribution line |
| 11 | Data handling disclosed in-product | ⚠️ | Options page mentions Google may use free-tier requests | Add a short first-run notice in the panel ("Your questions and the article text are sent to <provider>") with a link to the policy |

## Ready

| # | Item | Status | Evidence |
|---|---|---|---|
| 12 | Manifest V3 | ✅ | `manifest.json:2`, service worker |
| 13 | No remotely hosted code | ✅ | KaTeX and fonts bundled; no `eval`, `new Function` or remote `<script>`; default MV3 CSP |
| 14 | No obfuscation | ✅ | Readable source; `katex.min.js` is a standard minified release (allowed; keep `vendor/katex/README` with the version) |
| 15 | Single purpose | ✅ | Chat about the Wikipedia article you're reading; topic, map and history all serve it |
| 16 | No bundled secrets | ✅ | Users supply keys; `.env` not packaged |
| 17 | Icons 16/32/48/128 | ✅ | `icons/` |
| 18 | Description ≤ 132 characters | ✅ | `manifest.json:5` (94 characters) |
| 19 | Options page | ✅ | `options_ui` |

## Package hygiene before upload

| # | Item | Status | What to do |
|---|---|---|---|
| 20 | `TESTING.md` in the zip ("Load unpacked" instructions) | ⚠️ | Leave it out of the store build (`scripts/package.sh:17`) |
| 21 | `minimum_chrome_version` | ⚠️ | Add `"116"` (M-3) |
| 22 | Version bump | ✅ | `0.3.0`; bump for every upload |
| 23 | Store assets | ❓ Not in the repo | At least one 1280×800 screenshot, a 440×280 small promo tile, a detailed description, category, and a support URL or email |
| 24 | Wikimedia User-Agent with contact info | ⚠️ (not store policy, but a block risk) | W-1 |

## Rejection risk summary
1. Missing privacy policy and data disclosures (items 1–3): near-certain rejection, or a takedown later.
2. Broad optional host permissions plus required localhost (4–5): common cause of "excessive permissions" rejections or long reviews. Moving localhost to optional and documenting the runtime request usually clears it.
3. Undisclosed page modification (7): lower risk, but cheap to fix in the listing.

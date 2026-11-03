# Wiki AI: action plan

Ordered by impact within each group. Effort: **S** ≤ 2 h · **M** ≈ half a day to 2 days · **L** > 2 days. IDs refer to `CODE_REVIEW.md`, `SECURITY.md` and `STORE_READINESS.md`.

## Before publishing

**Progress (2026-11-03, uncommitted).**
- #2–#14 are done in code.
  - #12 tags Wikipedia text inside the system prompt instead of moving it into a user message, because some chat templates require strict user/assistant turns.
  - #9 adds the keepalive, but it hasn't been tested against a slow server.
- #1 is drafted in `PRIVACY.md` and `STORE_LISTING.md`. It still needs a contact email and a hosted URL.
- #15: formulas render through KaTeX in the harness. Still to check in Chrome with the extension reloaded.

| # | Fix | IDs | Effort |
|---|---|---|---|
| 1 | Write and host a privacy policy; fill in the Privacy practices tab (data categories, Limited Use); say in the listing that a provider API key is needed and that questions and article text go to that provider | P-1, Store 1–3 | M |
| 2 | Add a first-run notice in the panel naming the provider and linking the policy | Store 11 | S |
| 3 | Move `localhost`/`127.0.0.1` to optional host permissions; allow `http:` only for loopback, refuse other `http:` endpoints, and never send the key over `http:` to non-loopback hosts | M-1, M-2, S-3 | S |
| 4 | Check each sentence against its **own** cited passages; flag a mismatch and uncited factual sentences | C-1, C-2 | M |
| 5 | Reset `state.building` and show an error when the port drops during a topic build | L-1 | S |
| 6 | Serialise storage writes per key; store each topic under its own key | L-2 | M |
| 7 | Bound storage: save only cited sources, cap topics, cap total bytes (`getBytesInUse`), and show save failures in the UI | L-3, Q-3 | M |
| 8 | Hard cap on tool rounds; ignore tool calls in the forced final round | A-1 | S |
| 9 | Keep the worker alive during long fetches and rate-limit waits (or a content-side heartbeat); auto-retry once on disconnect. Test first with a slow local server | A-3 | M |
| 10 | Wikimedia `Api-User-Agent` with version from the manifest and contact info | W-1 | S |
| 11 | Delete a topic's chats with the topic (or ask) | H-2 | S |
| 12 | Move article text out of the system prompt into delimited `<passage>` blocks with a data-only rule | S-1 | M |
| 13 | Disclose or stop hiding Wikimedia banners; add the CC BY-SA attribution line | W-5, W-4 | S |
| 14 | `"minimum_chrome_version": "116"`; leave `TESTING.md` out of the store zip; prepare store assets | M-3, Q-8, Store 20–23 | S |
| 15 | Re-verify BUG-004 (LaTeX) on a freshly reloaded build | QA trace | S |

## Soon after

| # | Fix | IDs | Effort |
|---|---|---|---|
| 16 | Record `revid`; fetch HTML for the same revision; link citations with `oldid`; mark previews when the live page differs | C-3 | M |
| 17 | Fix "Open ↗" text fragments for table, infobox and figure sources; use `textStart,textEnd` for prose | C-4 | S |
| 18 | Stop pre-reading pages from earlier answers (`agent.js:437`); skip automatic hints for questions about the chat | A-7 (BUG-011, NEW-01) | S |
| 19 | Use the topic's language for topic links and for the agent's topic-article reads | H-1 | S |
| 20 | Script-aware token estimate; count tool definitions in `fit()`; narrower 400 retry | A-2 | S |
| 21 | Batch summaries via `action=query`; lower concurrency; `maxlag` on the topic build; fetch `action=parse` only when needed | W-2 | M |
| 22 | Timeouts and abort signals for Wikipedia fetches | W-3 | S |
| 23 | `onMessage` sender and shape validation; closed shadow root; `setAccessLevel(TRUSTED_CONTEXTS)` for `storage.local` | S-4, S-2, S-5 | S |
| 24 | Render only the pending message while streaming; separate live region; keep focus | Q-6 | M |
| 25 | Map: `role="group"` instead of `img`, a list alternative, and fix the overlay listener leak | H-4, H-3 | S |
| 26 | Test setup: `package.json`, `node --test`, ESLint (`no-empty`), GitHub Actions. Unit tests for `markdown.render`, `cite`/numbering, `parseExtract`/`chunkPage`, `fit`, `splitContent`/`sseEvents`/`repairJSON`, storage caps | Q-7 | M |
| 27 | Per-language back-matter section names; strip `{\displaystyle}` noise | C-6 | S |
| 28 | SSE: flush the last line, surface in-stream errors; `{once:true}` on sleep's abort listener; idle timeout instead of a whole-stream timeout | A-4, A-5, A-6 | S |
| 29 | Schema version plus migrations on update; validate stored records on read | L-6 | M |
| 30 | Drop follow-ups the answer already answers | A-9 (BUG-014) | S |

## Later

| # | Fix | IDs | Effort |
|---|---|---|---|
| 31 | Split `content.js` into page extraction, highlighting, views and i18n; move prompt rules into `lib/prompt.js` | Q-1 | L |
| 32 | Remove duplication (storage wrapper, `esc`, citation regex, URL builders, fallback logic, sentence splitting) | Q-2 | M |
| 33 | `// @ts-check` with JSDoc typedefs and `tsc --noEmit` in CI; validate model JSON shapes | Q-5 | M |
| 34 | Lazy-load KaTeX only when an answer contains math | Dependencies | M |
| 35 | Optional LLM verifier pass for semantic support of each citation (after #4) | C-1 | M |
| 36 | Stream answer text once per-sentence checks pass, or show clearer phase status | A-8 (BUG-028) | M |
| 37 | Clear the worker's in-memory caches on "Clear cache" and "Delete all" | L-5 | S |
| 38 | Section fallback by full path or heading id | C-5 | S |
| 39 | Local refusal for personal-contact questions before any tool call | NEW-02 | S |
| 40 | de.wikipedia header wrap when the panel is open | BUG-023 | S |
| 41 | Small cleanups: `rel="noopener noreferrer"`, `MAX_PAGES` off-by-one, `flagNotes` as a parameter, strip private-use characters, content-script match for variant paths | S-6, Q-9, Q-4, Step 1 notes | S |

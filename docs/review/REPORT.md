# Wiki AI: final review report

**As of 2026-11-03 15:47 CET.** Describes `main` at commit `5b26787` (2026-11-03 15:43 CET, after PR #7), plus [PR #8](https://github.com/salocin93/wiki-ai/pull/8), which brings this report and two topic fixes.

This closes the pre-publication review of commit `db7f2d6` (2026-11-02 02:22 CET, version 0.3.0), which was written on 2026-11-03, 02:57–03:37 CET. The review documents in this folder are a snapshot of that commit: [CODE_REVIEW.md](CODE_REVIEW.md), [SECURITY.md](SECURITY.md), [STORE_READINESS.md](STORE_READINESS.md), [ACTION_PLAN.md](ACTION_PLAN.md) and [ARCHITECTURE.md](ARCHITECTURE.md). This report gives the current status of each item and the pull request that fixed it.

## Summary

- **Fixed in code: all 41 action-plan items.** Two of them are done only in part, by choice: #31 keeps the panel's views in one file, and #33's type check isn't strict.
- **Not ready to publish yet.** What's left is mostly outside the code:
  - the privacy policy needs a contact email and a public address (the repo is private);
  - the store assets need to be made;
  - the extension hasn't had a full test run in Chrome since the changes.
- **One review finding is still open:** C-7, tables dropped silently when the article's HTML can't be loaded. It's Low severity.

## Timeline

All times CET (UTC+1). Merge times are from GitHub.

| When | What | Scope |
|---|---|---|
| 2026-11-02 02:22 | Commit `db7f2d6` | The reviewed version (0.3.0) |
| 2026-11-03 02:57–03:37 | Review written, added in `c63037a` | Read-only review: architecture, findings, security, store readiness, action plan |
| 2026-11-03 03:40 | [PR #1](https://github.com/salocin93/wiki-ai/pull/1) merged | Action plan 1–15 (before publishing) |
| 2026-11-03 13:20 | [PR #2](https://github.com/salocin93/wiki-ai/pull/2) merged | Action plan 16–30 (soon after), without ESLint |
| 2026-11-03 13:24 | [PR #3](https://github.com/salocin93/wiki-ai/pull/3) merged | ESLint (rest of #26) |
| 2026-11-03 13:58 | [PR #4](https://github.com/salocin93/wiki-ai/pull/4) merged | Action plan 31–41 (later), including the optional model citation check (#35) |
| 2026-11-03 14:27 | [PR #5](https://github.com/salocin93/wiki-ai/pull/5) merged | ES modules and an esbuild build (not a review item) |
| 2026-11-03 15:27 | [PR #6](https://github.com/salocin93/wiki-ai/pull/6) merged | Four bugs found while testing |
| 2026-11-03 15:43 | [PR #7](https://github.com/salocin93/wiki-ai/pull/7) merged | Citation check reworked: fix or leave out unbacked claims instead of underlining them |
| 2026-11-03 | [PR #8](https://github.com/salocin93/wiki-ai/pull/8) opened | Topic panel wording and the missing "Build a topic cluster" link; this documentation cleanup |

## Action plan items

Status: **Done**, **Partly** (with what's left), or **Open**. "Not tried in Chrome" means it was checked in the test harness or unit tests only.

### Before publishing (PR #1)

| # | Item | IDs | Status | Notes |
|---|---|---|---|---|
| 1 | Privacy policy, Privacy practices tab, provider disclosure in the listing | P-1, Store 1–3 | Partly | Written: [PRIVACY.md](../../PRIVACY.md) and [STORE_LISTING.md](../STORE_LISTING.md). Still to do: fill in `<CONTACT EMAIL>`; make the policy reachable (the extension links to it on GitHub, and the repo is private); fill in the dashboard forms |
| 2 | First-run notice naming the provider, linking the policy | Store 11 | Done | |
| 3 | `localhost` optional; plain `http:` only for this computer and the local network | M-1, M-2, S-3 | Done | |
| 4 | Check each sentence against its own cited passages | C-1, C-2 | Done | Reworked in PR #7: unbacked claims are fixed once, then left out (see below) |
| 5 | Reset the topic build when the connection drops | L-1 | Done | |
| 6 | Serialise storage writes | L-2 | Done | Writes go through a per-key lock. Topics still share one storage key, which the lock makes safe |
| 7 | Bounded storage, save failures shown | L-3, Q-3 | Done | 50 topics, 8 MB of chats (least recently used dropped), uncited passages saved without text |
| 8 | Hard cap on tool rounds | A-1 | Done | |
| 9 | Keep the service worker alive during long requests | A-3 | Done | Not tested against a slow server |
| 10 | Wikimedia `Api-User-Agent` with version and contact | W-1 | Done | |
| 11 | Delete a topic's chats with the topic | H-2 | Done | |
| 12 | Wikipedia text as delimited data, not instructions | S-1 | Done | Tagged inside the system prompt, since some chat templates require strict user/assistant turns |
| 13 | Stop hiding Wikimedia banners; CC BY-SA attribution | W-5, W-4 | Done | |
| 14 | `minimum_chrome_version`, tester guide out of the store zip, store assets | M-3, Q-8, Store 20–23 | Partly | Code done. Screenshots and the promo tile aren't made yet |
| 15 | Re-check formulas (BUG-004) on a fresh build | QA trace | Partly | Formulas render in the harness; not tried in Chrome |

### Soon after (PR #2, ESLint in PR #3)

| # | Item | IDs | Status | Notes |
|---|---|---|---|---|
| 16 | Record the revision; link citations to it; flag previews of changed passages | C-3 | Done | |
| 17 | Text fragments for table, infobox and figure sources; start and end words for prose | C-4 | Done | |
| 18 | No pre-reading of pages from earlier answers; no lookups for questions about the chat | A-7 (BUG-011, NEW-01) | Done | |
| 19 | Topic articles in the topic's language | H-1 | Done | |
| 20 | Token estimate for Chinese, Japanese and Korean; tool definitions in the budget; narrower 400 retry | A-2 | Done | |
| 21 | Batched summaries, `maxlag`, lower concurrency, article HTML only when needed | W-2 | Done | |
| 22 | Timeouts and cancelling for Wikipedia requests | W-3 | Done | |
| 23 | Message sender and shape checks; closed shadow root; storage limited to trusted contexts | S-4, S-2, S-5 | Done | The storage restriction isn't confirmed in Chrome |
| 24 | Redraw only the pending message; separate live region; keep focus | Q-6 | Done | |
| 25 | Accessible map with a list view; overlay listener leak | H-4, H-3 | Done | |
| 26 | Tests, ESLint, GitHub Actions | Q-7 | Done | ESLint in PR #3. CI runs lint, the type check, syntax checks, the tests (28 now) and the build |
| 27 | Back-matter section names in many languages; formulas as LaTeX | C-6 | Done | |
| 28 | Stream fixes: last line, in-stream errors, idle timeout | A-4, A-5, A-6 | Done | |
| 29 | Storage schema version and migrations; settings validated | L-6 | Done | |
| 30 | Drop follow-ups an answer already answered | A-9 (BUG-014) | Done | |

### Later (PR #4)

| # | Item | IDs | Status | Notes |
|---|---|---|---|---|
| 31 | Split `content.js` | Q-1 | Partly, by choice | Page reading, highlighting, phrases and the system prompt are in their own files. The views share the panel's state, so they stay together. PR #5 made the code ES modules |
| 32 | Remove duplication | Q-2 | Done | The three sentence splitters stay separate on purpose: each needs different boundaries |
| 33 | Type checking; check model JSON | Q-5 | Done | `npm run typecheck` in CI, with typed records in `types/`. Not strict |
| 34 | Load KaTeX only when an answer has a formula | Dependencies | Done | Not tried in Chrome |
| 35 | Optional model check of each citation | C-1 | Done | Off by default (Settings › Answers). Reworked in PR #7; not tried with a real model |
| 36 | Clearer status while an answer is written | A-8 (BUG-028) | Done | Word count while writing; the answer still isn't shown until it's checked |
| 37 | Clear the worker's memory on "Clear cache" and "Delete all" | L-5 | Done | Already in PR #1 |
| 38 | Citation fallback by full section path | C-5 | Done | |
| 39 | Answer questions for private contact details locally | NEW-02 | Done | English, German, French and Spanish |
| 40 | German Wikipedia header wrapping with the panel open | BUG-023 | Done | Checked on the live site |
| 41 | Small cleanups: `noreferrer`, 60-article cap, flag notes, private-use characters, variant paths | S-6, Q-9, Q-4 | Done | |

## Findings without an action-plan item

| ID | Severity | Status | Notes |
|---|---|---|---|
| C-7 | Low | **Open** | If the article's HTML can't be loaded, its tables, infobox and images are dropped without a word. A malformed `%` in an image file name still throws (`lib/tables.js`). Fix: catch per image, and note in the prompt that tables couldn't be loaded |
| C-8 | Low | Accepted | Disambiguation pages are answered from their list of meanings |
| L-4 | Low | Done (PR #1) | Cache transactions now reject when aborted |
| H-5 | Low | No action | Map performance is fine up to the 60-article cap |

## QA bugs traced in the review

Only those whose status changed since the review. The rest are as the review's trace says.

| Bug | Now |
|---|---|
| BUG-004 formulas shown as raw LaTeX | Render in the harness; not tried in Chrome (#15, #34) |
| BUG-011 old research steps reappear | Fixed (#18) |
| BUG-013 uncited claims | Reworked in PR #7: unbacked claims are fixed or left out |
| BUG-014 repeated follow-ups | Fixed (#30) |
| BUG-023 page shift on German Wikipedia | Fixed (#40) |
| BUG-028 no streaming | By design; clearer status instead (#36) |
| NEW-01 off-topic answer after reload | Fixed (#18) |
| NEW-02 private contact lookup | Fixed (#39) |
| BUG-010 follow-ups in English | **Open.** Only a prompt rule; nothing checks the language of the follow-ups |

## Fixed after the review

Found while testing the extension, not by the review.

| Where | What |
|---|---|
| PR #6 | Closing the active topic didn't work on its own articles. The Map view's saved-topic list didn't scroll. The note under flagged answers was misleading. An article answer showed under the Topic tab after a topic finished building |
| PR #7 | A sentence was marked "not supported" while showing a source number, and the word check flagged correct sentences. Now an unbacked claim is sent back to the model once, then left out, with a collapsed note listing what was left out. With the model check on, the model decides for every cited sentence. No more underlines or per-answer switch |
| PR #8 | The Topic view said "Questions now use …" before a topic was built. The chat offered no way to build a topic while a topic from another article was open |

## Still to do

**Before submitting to the Chrome Web Store**
1. Fill in `<CONTACT EMAIL>` in [PRIVACY.md](../../PRIVACY.md) and [STORE_LISTING.md](../STORE_LISTING.md).
2. Make the privacy policy reachable at a stable public address. Either make the repo public, or host the policy elsewhere and change `PRIVACY_URL` in `lib/settings.js`. Put the same address in the listing.
3. Make the screenshots (1280×800) and the small promo tile (440×280).
4. Fill in the dashboard: privacy practices, permission justifications, single purpose. The text for each is in [STORE_LISTING.md](../STORE_LISTING.md).
5. Bump `version` in `manifest.json`, then `npm run package:store`.

**Test in Chrome** (load `dist/wiki-ai` after `npm run build`)
- Formulas render (KaTeX loads on first use).
- The panel opens on Chinese and Serbian script-variant pages and on `/w/index.php` article views, and stays off edit pages, histories and old revisions.
- The model citation check with a real model: speed (debug info shows its share), and whether it leaves out too much.
- A long answer on a slow model: the service worker stays alive.

**Code**
- C-7: tables dropped silently (above).
- BUG-010: check the language of suggested follow-ups.

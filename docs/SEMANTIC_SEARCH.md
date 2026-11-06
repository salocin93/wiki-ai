# Semantic search (experimental)

Off by default. Settings › Semantic search turns it on. Without it, retrieval is BM25 keyword search. With it, retrieval is led
by meaning, and falls back to keywords whenever embeddings aren't available, so it can only add good passages, never break an
answer.

## What it does

An article is embedded **one text per section**: the section's heading path plus its first ~90 words (`lib/embeddings.js`).
A question is embedded too, and the sections are ranked by cosine similarity. The passages inside the best sections are then
ordered by how well they match the question's words (BM25), two per section, and the best keyword match anywhere is kept so
an exact name or date is never lost. If no section is related enough, the keyword results are used as before.

It replaces the direct BM25 calls in the agent (`Run.retrieve`): `search_article`, `search_linked_article`, `search_topic`, and
the passages read ahead (`hints()`, `otherArticleHints()`: 6 passages of this article, 4 when another is named, 5 of each named article, 8 for a topic; each bounded by the token budget, so no extra request; with semantic search that is about three sections, two passages each). Link search (`find_linked_articles`, `recommend_reading`) and
building a topic (`lib/cluster.js`) stay keyword-only.

Why sections, and why not fusion with BM25: measured with `test/semantic-eval.mjs` on 14 questions worded differently from the
article (Cat, Coffee), the right section was among the top 3 passages for

| | first | top 3 | texts embedded |
|---|---|---|---|
| keywords | 5 | 9 | none |
| every passage embedded | 12 | 13 | 148 |
| one text per section | 13 | 13 | 74 |
| keywords + passages, fused | 8 | 12 | 148 |
| only top-level sections | 9 | 11 | 23 |

Re-measured through the real retrieval path (`semantic` in `test/semantic-eval.mjs`): right section first for 13 of 14, in the
top 3 for 13 of 14, against 5 and 9 for keywords. Sections lose nothing against passages at half the cost, and fusing with keyword ranks made first place worse. The sample is
small and the questions were chosen to avoid the article's words, which favors embeddings; keywords still win on names and dates,
which is why the best keyword match is kept. Re-run the script after changes.

## Backends

| | Gemini (default) | Any OpenAI-compatible server |
|---|---|---|
| Models | `gemini-embedding-001` and `gemini-embedding-2`, **each with its own free quota** | the one named in the settings |
| Endpoint | `models/<model>:batchEmbedContents` | `<address>/embeddings` |
| Task | 001: `taskType` field. 2: part of the text (`title: … \| text: …` for sections, `task: search result \| query: …` for questions) | optional prefixes in the settings (nomic, e5, bge want them) |
| Details | 768 dimensions, 50 sections per request | 32 per request |
| Key | the chat key (only to the same host) | none, or its own key; the chat key is never sent to another address |

Local server: Settings › Semantic search › Embedding model, enter e.g. `http://localhost:11434/v1` and `nomic-embed-text` (prefixes
`search_document: ` and `search_query: `), click **Test embedding model**. The browser asks once to let Wiki AI reach the address.

## Free-tier limits and the budget

Gemini's free tier allows, per embedding model, 100 requests a minute, 1,000 a day and 30,000 tokens a minute, and **every text
counts as a request**: a batch of 100 uses the whole minute (seen in the 429s: `embed_content_free_tier_requests`, limit 100;
confirmed for `gemini-embedding-2` on the usage dashboard by sending one call of 7 texts, which counted 7). So batching saves
nothing, and the unit has to be small.

- An article costs about 35 requests (sections), a question about it 1. With two models that is about 50 questioned articles a day,
  plus follow-ups. Every article the model opens counts, and a topic costs its articles' sections (refused above 400 sections).
- The count is kept per model and day (quotas reset at midnight Pacific time) in `chrome.storage.local`. Settings › Daily limit
  changes it (0 = 1,000 on Gemini, none elsewhere; -1 = none, e.g. a paid key).
- **New articles stop at 85% of a model's day**, so questions about embedded articles still get their 1-request question
  embedding. An article keeps the model it was embedded with (vectors of different models can't be compared); a new article
  goes to the model with more budget left.
- Embedding runs as a background job in batches saved as they finish. A question waits up to 6 s, then uses keyword search
  ("Semantic index still building in the background"); later questions find it ready. On a 429 the job waits as long as the
  server says, up to 8 tries; a question never retries.
- When the day's budget is used up, answers use keywords until it resets ("Today's embedding budget is used up").

## When an article is embedded (the gate)

Embedding an article costs about 35 requests, so a question only starts it when keyword search looks unsure (`embeddings.gate`,
Settings › "Save quota"; on by default, applies to articles, not yet to topics). It decides from the keyword results, before any
request is spent:

1. **Vectors already stored** → use them (a question then costs 1 request).
2. **No quota to protect** (a local model, or a paid key with the daily limit at -1) or the gate switched off → use.
3. **Short question**: two or fewer of its words exist in the article ("what do cats eat?") → use, because coverage can't judge it.
   This includes a question with no keyword match at all, which is what embeddings are best at.
4. Otherwise compare the **keyword coverage** of the top passage (`BM25.confidence`: the share of the question's words, weighted by
   how rare each is, that the best passage contains) with a threshold: below it, embed; at or above it, answer from keywords.
   The threshold is 0.7 while more than 70% of the day's new-article budget is left, 0.6 normally, 0.5 below 30%.

The debug info records each decision (`semantic gate: skip (keywords confident (coverage 0.76 ≥ 0.6))`).

Measured with `test/semantic-eval.mjs` (39 hard questions, keyword search only) and on real questions:
- Coverage of the top passage separates the questions keywords got wrong from those they got right (AUC 0.82); top score and gap to
  the second passage 0.67; coverage of the top three passages 0.73; whether the question's words exist in the article, heading
  matches and number of sections are close to chance.
- "Embed below 0.6" sent 21 of the 39 hard questions to embeddings and caught 9 of the 11 keyword misses; below 0.7 caught all 11
  at 27 of 39. These are deliberately hard questions, so real traffic should embed much less.
- On 11 real questions from the first sessions, it would have embedded 2 and skipped 9; 8 of those were fine, and one ("what do
  cats eat?", coverage 1.0 because both words appear in a hunting passage) missed the *Diet* section, which rule 3 now covers.

Limits: the thresholds come from 39 questions on 6 articles and may be overfitted. A question with no keyword match on an
off-topic subject also embeds the article once ("what is the capital of Australia"), since it can't be told from a pure
paraphrase; the vectors are reused by later questions. `--no-gate` in the eval compares with embedding on every question.

## Storage

- Vectors are unit-length `Float32Array`s, one per section (about 3 KB each, ~100 KB per article), stored per batch in the article
  cache under `emb:` keys (model, article, revision and content size). They live **7 days**, not 24 hours, because they cost quota
  to make; an edited article has a new key. They share the cache's 300-entry cap with articles.
- Changing the model or the passage prefix changes the key, so articles are embedded again; stale vectors are never mixed in.
- An article with more than 60 sections is embedded by top-level section instead (its subsections' names are in the text), so
  the biggest articles don't use up the day.
- After a failure (no key, wrong model, server off) nothing is retried for a minute and answers use keywords. The panel says
  "Semantic search unavailable" once per answer; "Copy debug info" has the reason.

## Limits of this prototype

- The similarity floor comes from `test/semantic-eval.mjs --unrelated` on Coffee (001) and Cat (2): unrelated questions topped
  out at 0.53 and 0.56, right sections started at 0.61 and 0.69, so the floors are 0.55 for `gemini-embedding-001` and 0.62 for
  `gemini-embedding-2` (provisional: one article each). Other models have none until one is set in the settings. Scores differ
  between articles, so recheck on a few more before trusting the margins.
- Semantic ranking still misses loosely worded questions: "which places do people sit in to drink it together" scored the
  Coffeehouses section below another one (13 of 14 right on the test questions, not 14).
- The article cache is shared, so vectors take entries from the 300-entry cap.
- The within-section pick is keyword-based; the sections' later passages aren't embedded.

## Trying it

```bash
npm test                                   # includes test/embeddings.test.mjs (fake server, no network)
node test/semantic-eval.mjs --bm25-only    # the keyword baseline, no key
GEMINI_API_KEY=… node test/semantic-eval.mjs --only=Cat,Coffee --unrelated
GEMINI_API_KEY=… node test/semantic-eval.mjs --only=Cat,Coffee --no-gate   # embed on every question, to compare with the gate
EMBED_URL=http://localhost:11434/v1 EMBED_MODEL=nomic-embed-text \
  EMBED_DOC_PREFIX='search_document: ' EMBED_QUERY_PREFIX='search_query: ' node test/semantic-eval.mjs --only=Cat,Coffee
GEMINI_API_KEY=… node test/embed-quota-check.mjs gemini-embedding-2 --probe=7   # does the limit count calls or texts?
```

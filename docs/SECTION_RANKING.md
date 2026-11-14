# Section ranking (experimental)

Off by default. Settings › Section ranking turns it on. It works with the Google Gemini API only.

## What it does

For each search (the passages read ahead for a question, `search_article`, `search_linked_article`, `search_topic`),
`gemini-decision-1` rates every section of the article against the question in **one call** to Google's Decisions API
(`lib/decisions.js`). It generates no text: each section gets a score from 0 to 3. Keyword search (BM25) then picks the
passages inside the best sections, two per section, and the best keyword match anywhere is kept, exactly as semantic
search does (`embeddings.passagesIn`).

- **The request:** the shared input is the reader's question. Each section is its own question: its heading path and
  opening ~90 words (the same unit embeddings use), rated on four levels from "Unrelated" to "Directly answers".
- **What counts as related:** a score of at least 1.5 (`MIN_SCORE`), up to 8 sections. If none reaches it, the keyword
  results are used.
- **Nothing is stored:** no vectors, no background job, no daily budget to track.

## When it isn't used

It runs before semantic search. When it can't answer, retrieval carries on as it would without it: embeddings if
Semantic search is on, keywords otherwise. "Copy debug info" has the reason (`section ranking not used: …`).

| Situation | What happens |
|---|---|
| No reply within 2.5 s, or any error (429, 5xx, network) | Falls back, and makes no further calls for a minute |
| More than about 20,000 tokens for one call (a whole topic, a very large article) | Falls back for that search |
| More than 45,000 tokens sent in the last minute (the free tier allows 50,000) | Falls back until the minute has passed |
| Another provider, or no key | Never called |

## Measured

`test/decision-check.mjs --rank --layout=question --unrelated`, on the 39 questions of `test/semantic-questions.mjs`
(worded differently from their article, 6 articles), counting a hit when one of the 3 passages read ahead is in the
expected section:

| | first | top 3 | cost |
|---|---|---|---|
| keywords | 18 | 28 | none |
| section ranking | 36 | 39 | 1 call per question: median 0.8 s (1.9 s at most), about 6,000 input tokens |

- The best section of a related question scored 2.33 to 2.97; of an unrelated one ("what is the capital of Australia" on Great Barrier Reef) 0.68 at
  most, which is where the 1.5 floor comes from.
- On Cat and Coffee (14 questions) it was right first for all 14; embeddings were measured at 13 of 14 on the same
  questions (`docs/SEMANTIC_SEARCH.md`), in a separate run.
- Numbering all sections in the shared input instead (`--layout=input`) was as accurate on those 14 but slower (median
  770 ms against 533 ms) and scored unrelated questions higher (0.48 against 0.23 at most).
- A call's time grows with the number of questions more than with the text: 1 question about 0.5 s, 38 about 0.75 s,
  200 about 1.7 s (`test/decision-check.mjs` without flags).

Limits: the expected sections are one person's judgment, all six articles are English, and the yes/no question type
(`--type=noul`), which would cost fewer tokens, hasn't been measured.

## Free-tier limits

`gemini-decision-1` is free on the free tier: 200 requests and 50,000 input tokens a minute, 10,000 requests a day. Tokens
are the limit that matters: at 6,000 to 10,000 a search, about five searches a minute fit. Each rating repeats the four
level descriptions, about 140 tokens per section.

## Trying it

```bash
npm test                                                        # includes test/decisions.test.mjs (fake server, no network)
node --env-file=.env test/decision-check.mjs                    # latency by number of questions
node --env-file=.env test/decision-check.mjs --rank --only=Cat,Coffee --unrelated
SECTION_RANKING=1 LLM_API_KEY=… node test/agent-cli.mjs "Cat" "how long do they live"
```

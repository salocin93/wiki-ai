# Semantic search (experimental)

Off by default. Settings › Semantic search turns it on. Retrieval stays BM25 when it's off, and also when anything about
embeddings fails, so it can only add passages, never break an answer.

## What it does

Each ~160-word passage is embedded (`lib/embeddings.js`). A question is embedded too, and passages are ranked by cosine
similarity. That list is fused with the BM25 list by reciprocal rank fusion, so a passage both lists like rises most and
neither score has to be calibrated against the other. This finds a passage that says the same thing in other words
("why have harbours survived underwater" → the passage on seawater and lime), and one in another language.

It replaces the four `index.search` calls the agent made (`Run.retrieve`): `search_article`, `search_linked_article`,
`search_topic`, and the passages read ahead in `hints()` / `otherArticleHints()`. Link search stays keyword-only.

## Backends

| | Gemini (default) | Any OpenAI-compatible server |
|---|---|---|
| Endpoint | `models/gemini-embedding-001:batchEmbedContents` | `<address>/embeddings` |
| Used when | the embedding address is empty and the chat provider is Gemini, or the address is Gemini's | any other address |
| Details | task types `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`, 768 dimensions, 100 passages per request | model name required, 32 passages per request, optional passage/question prefixes (nomic, e5, bge want them) |
| Key | the chat key (only to the same host) | none, or its own key; the chat key is never sent to another address |

Local server: Settings › Semantic search › Embedding model, enter e.g. `http://localhost:11434/v1` and `nomic-embed-text`
(prefixes `search_document: ` and `search_query: `), click **Test embedding model**. The browser asks once to let Wiki AI
reach the address.

## Storage and cost

- Vectors are unit-length `Float32Array`s, one per passage, stored in the article cache (`emb:` keys: model, article,
  revision and content size). 768 dimensions is about 3 KB per passage, so about 300 KB for a long article. They expire
  with the article after 24 h and count towards its 300-entry cap.
- Changing the model or the passage prefix changes the key, so articles are embedded again; stale vectors are never
  mixed in. A size mismatch between stored vectors and a question is an error, not a wrong ranking.
- One request per article (a long one is two) on first use, then free. Questions are one small request each (the last 50
  are remembered in memory).
- After a failure (no key, rate limit, server off) the passages aren't retried for a minute, and the answer uses keyword
  search. The panel shows "Semantic search unavailable" once per answer; "Copy debug info" has the reason.

## Limits of this prototype

- **Topics:** a topic is embedded only if it has at most 600 passages (`TOPIC_CHUNK_CAP`); bigger ones use keywords.
  A 50-article topic usually exceeds that. Options: embed lazily in the background, or rerank BM25's top 150 only.
- **Cut-off:** a passage must score at least `minScore`, or it's ignored. Measured on `gemini-embedding-001` with the
  Roman concrete article: unrelated questions ("who won the 2018 World Cup", "how do I bake sourdough bread") top out at
  0.47–0.50; related ones start at 0.58 (a vague "who wrote about the recipe") and reach 0.75. The default is 0.55 for
  that model and none for any other, since scales differ per model: calibrate with `test/semantic-check.mjs` and set
  Settings › Minimum similarity. `MARGIN` (0.12 below the best hit) is a second, looser filter; scores of one question
  sit within a few hundredths, so it removes little.
- Passages are embedded as `Title — Section\ntext`; tables are included when the article was read with them.
- The article cache is shared, so vectors take entries from the 300-entry cap. A separate store would avoid that.

## Trying it

```bash
npm test                                   # includes test/embeddings.test.mjs (fake server, no network)
GEMINI_API_KEY=… node test/semantic-check.mjs "Roman concrete"
EMBED_URL=http://localhost:11434/v1 EMBED_MODEL=nomic-embed-text \
  EMBED_DOC_PREFIX='search_document: ' EMBED_QUERY_PREFIX='search_query: ' node test/semantic-check.mjs
```

The script prints, per question, the top passages from keywords, from meaning and fused, with scores.

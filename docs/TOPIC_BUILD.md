# How a topic cluster gets built

What happens from clicking **Build a topic cluster** to the finished topic: every step, every network call and the exact prompt.

- **Source of the example:** a real World War I build (`ww1_topic_gemini-3.1-flash-lite.har`), 26 network calls in about 12 seconds.
- **Checked:** the prompt below is generated from `lib/cluster.js`, and its fixed text was matched character by character against the request in that log.
- **Newer than the log:** the strong-link marking in step 10 was added after that log was recorded. It adds no network calls.

## Overview

| Step | What happens | Where | Network calls (World War I) |
|---|---|---|---|
| 1 | Read links and categories from the open page | Panel | 0 |
| 2 | Hand the job to the service worker and load settings | Service worker | 0 |
| 3 | Fetch the article's text | `wiki.getIndexedPage` | 1 (#1) |
| 4 | Rank the links | `cluster.rankCandidates` | 0 |
| 5 | Check the linked articles | `wiki.linkStats` | 15 (#2–16) |
| 6 | Ask the model for a plan | `cluster.plan` | 1 (#17) |
| 7 | Run searches the model asked for | `wiki.search` | 1 (#18) |
| 8 | Confirm that the titles exist | `wiki.resolveTitles` | 1 (#19) |
| 9 | Fetch descriptions and intros | `wiki.describeMany` | 3 (#20–22) |
| 10 | Map links between the articles and mark strong ones | `wiki.linksBetween` | 4 (#23–26) |
| 11 | Save the topic and show it | `topics.save` | 0 |

**Total: 25 calls to Wikipedia and 1 to the model.** There is no Wikidata call in a build (see [the type check](#why-theres-no-type-check-here)).

## Step by step

### 1. Read the open page (no network)

The panel's `pageInfo()` in `content/page.js` reads the page already on your screen:

- **Links:** `collectLinks()` records each linked article's title, link text, how often it's mentioned, the first two sentences or labels where it appears, its sections, its navigation boxes and its signals (`main`, `infobox`, `navbox`, `seealso`, `hatnote`).
- **Categories:** from the category list at the bottom of the page.

Disambiguation pages stop here with a message. Otherwise this goes to the service worker as `{type: 'buildTopic', page}`.

### 2. Service worker takes over (no network)

`background/background.js` checks the message is well formed and loads your settings. A timer keeps the worker alive during the build. Every step is logged to the service worker's console as `Wiki AI: topic build: …`.

### 3. Fetch the article's text: call #1

| Call | Request | Purpose |
|---|---|---|
| #1 | `action=query, prop=extracts\|info, explaintext, exsectionformat=wiki, titles=World War I` | Full plain text, about 90,000 characters |

- The prompt only uses the intro, the outline and the word count.
- The build asks for no HTML, so tables and images aren't downloaded. An article chat does download them (see `docs/ARTICLE_CHAT.md`).
- The text is cached for 24 hours. If it's cached, this call doesn't happen.

### 4. Rank the links (no network)

`rankCandidates` scores each link in `lib/links.js`:

| Signal | Score |
|---|---|
| Mentions in the text | +1 each, up to 5 |
| Main article of a section | +4 |
| In the introduction | +3 |
| In the fact box | +2 |
| In "See also" | +2 |
| In a navigation box about this subject | up to +3, less for a very large box |
| In another subject's navigation box | +0.5 |
| Only in another subject's box, never in the text or fact box | a further −1 |
| Dates, "List of …" and reference plumbing such as JSTOR | always −5 |

A link is kept if it scores at least 3, or at least 20% of the top five's average if that's higher.

The list is capped by the prompt budget:

```
budget = 32,000 tokens (Gemini), 16,000 (Gemma or other providers), or your own setting
space  = budget − 1,500 − 1,500 = 29,000
room   = max(40, 29,000 × 0.8 ÷ 45 tokens per candidate) = 515 candidates
```

### 5. Check the linked articles: calls #2–16

`linkedBack` asks Wikipedia about the ranked links **and** every link found in the article's text. For World War I that's 714 articles. The API takes 50 titles per request, so that's 15 calls, two at a time.

| Call | Request | Purpose |
|---|---|---|
| #2–16 | `action=query, redirects, titles=(50 titles), prop=info\|description\|pageprops\|links, ppprop=disambiguation, pltitles=World War I` | Length, description, disambiguation flag, and whether each article links back |

The answers are used to:

- **Remove** disambiguation pages from the candidates.
- **Tag** candidates that link back with `back`.
- **Add extras:** in-text links that didn't make the ranking but link back, aren't disambiguation pages and are at least 4,000 bytes long. These go in the prompt as names only.

These results **aren't cached**, so every build repeats these calls.

For World War I, 545 of the 714 link back. The prompt got 151 candidates with context and 407 extras, 558 in total.

### 6. Ask the model for a plan: call #17

The full prompt is [below](#the-prompt). If the prompt is over the budget, the user message is cut to fit.

| Setting sent | Value in the log | Comes from |
|---|---|---|
| Endpoint | `generativelanguage.googleapis.com/v1beta/openai/chat/completions` | Settings: provider |
| `model` | `gemini-3.1-flash-lite` | Settings: model |
| `stream` | `true` | Fixed |
| `temperature` | `0.1` | Fixed |
| `max_tokens` | `4000` in this log | Fixed: now 6,000 on the Gemini API, 1,500 elsewhere |
| `reasoning_effort` | `low` | Fast answers on, Gemini 3 models. Other providers get a different setting, and Gemma gets none |
| `response_format` | `{type: 'json_object'}` | Fixed. If a server rejects it, the request is sent again without it |

**What can trigger extra model calls:**

| Situation | What happens |
|---|---|
| Main model returns 503, 429 or 404 | Switches to the fallback model at once, if one is set |
| 503 or 429 with no model left to try | Waits as long as the server asks, or 10, 30, then 60 seconds. A used-up daily quota stops immediately |
| Reply cut off or hits the token limit | Treated as a 503, so it goes to the fallback model. The build fails if there's no fallback or it's cut off too |
| Reply is complete but isn't valid JSON | Asks once more: "That was not valid JSON. Reply again with only the JSON object." |
| Still not valid JSON | The build fails: "the model's reply was garbled twice" |
| Article over 8,000 words, under 25 picks and at least 40 candidates | Asks once for a fuller topic (see [the follow-up prompt](#the-fuller-topic-follow-up)) |

The World War I log needed none of these. The first attempt worked and returned 45 picks.

### 7. Run searches the model asked for: call #18

The prompt tells the model: "If an important theme has no fitting candidate, add a short Wikipedia search query for it under "search"." This model asked for one:

```json
"search": [{"facet": "Society and Impact", "query": "social impact of World War I on women"}]
```

| Call | Request | Purpose |
|---|---|---|
| #18 | `action=query, list=search, srsearch=(the model's query), srlimit=2, srnamespace=0` | Top 2 results for each query |

At most 5 queries run, one after another. Results join the named theme, and a new theme is created if the name is unknown.

In this log, the search returned "World War I" and "World War I casualties", which were both already in the topic, so it added nothing. If the model asks for no searches, this step makes no calls.

### 8. Confirm that the titles exist: call #19

| Call | Request | Purpose |
|---|---|---|
| #19 | `action=query, redirects, titles=(46 titles)` | Follows redirects and drops anything that doesn't exist |

Duplicates are removed and the topic stops at 60 articles. The model can't invent a title, because it picks by number, but search results and renamed articles still need checking. One call per 50 titles.

### 9. Fetch descriptions and intros: calls #20–22

| Call | Request | Articles | Purpose |
|---|---|---|---|
| #20 | `action=query, prop=extracts\|description, exintro, explaintext, exlimit=20` | 20 | Description and intro |
| #21 | Same | 20 | Same |
| #22 | Same | 6 | Same |

The API returns at most 20 intros per request, so this runs in batches of 20, one after another.

Then two kinds of article are removed, unless the starting article is itself a journal, publisher or university:

- Articles whose description mentions a journal, periodical, magazine, publisher, university or college.
- Articles titled "List of", "Timeline of", "Outline of" or "Index of".

Only the first 280 characters of each intro are saved with the topic.

### 10. Map the links between articles: calls #23–26

| Call | Request | Links returned |
|---|---|---|
| #23 | `action=query, prop=links, titles=(46), pltitles=(46), pllimit=max` | 500 |
| #24 | Same, plus `plcontinue` | 500 |
| #25 | Same, plus `plcontinue` | 500 |
| #26 | Same, plus `plcontinue` | 190 |

All four ask one question: which of these articles link to which? Wikipedia returns 500 links per response, so this takes several pages, one after another, because each page needs a token from the previous one.

**Strong links (no network):** most of these links come from a navigation box the articles share. `markStrongLinks` marks a link as strong when the source article's intro names the target, using the intros from step 9. The chat's link list shows strong links first. The map doesn't use them yet.

### 11. Save and show the topic (no network)

The topic is saved to `chrome.storage.local` and made active, then the panel gets `{type: 'topicBuilt', topic}`:

```
{id, name, kind, lang, seed, createdAt,
 facets: [{name, why}],
 pages:  [{title, facet, why, description, summary, seed?}],
 edges:  [[from, to], [from, to, 1], …]}   // 1 = strong link
```

## The prompt

`{{LIKE_THIS}}` marks dynamic data. Everything else is fixed text in `lib/cluster.js`.

### System message

```
You organize Wikipedia articles into a topic cluster for a reader exploring a subject. You choose only from the numbered candidate articles you are given. You reply with one JSON object and nothing else.
```

### User message

```
Starting article: "{{TITLE}}"

Introduction:
{{INTRO}}

Sections: {{OUTLINE}}
Length: about {{WORDS}} words, {{SIZE}}.
Categories: {{CATEGORIES}}

Candidate articles: the {{CANDIDATE_COUNT}} linked articles relevant to it (number. title — where the starting article links to it [navbox = listed in a navigation box, main = a section's main article, infobox = in the fact box, back = its own article mentions "{{TITLE}}"]):
{{CANDIDATE_LINES}}

More candidates, linked only once but whose own articles mention "{{TITLE}}":
{{EXTRA_LIST}}

Build a topic cluster around "{{TITLE}}":
- Decide how many articles a reader needs to explore this subject well. Include every candidate that is central to it and leave out ones that are only loosely related: a narrow subject may need 8 articles, a broad one 40 or more (never more than 60).
- Group them into as many themes as the subject really has (usually 3 to 8), each named in a few words. Prefer articles about the subject's own people, branches, places, events and ideas; skip generic articles (whole countries, languages, titles like "King", wars, eras, broad fields) unless the subject is mainly about them. Skip journals, publishers, universities, awards and timelines or lists: they are where the subject was published or honoured, not part of it.
- A broad subject (a war, a country, a field) needs its central people, events and consequences, even well-known ones: for a war, its leaders, its decisive battles and invasions, its atrocities and its aftermath.
- Use themes a reader would expect for this kind of article, so similar articles get comparable themes: a scientific concept → theory, discovery and history, applications, related phenomena; a person → life, work, people around them, legacy; an event → causes, course, key people, consequences; a place → geography, history, culture, economy. Put each article under the theme it is mainly about (an aftermath article under consequences, not under the sides involved).
- When a specific article and a broad one cover the same part of the subject, pick the specific one: the conference, treaty, book or reform the subject was part of, not the whole war or era around it. Articles marked "back" or listed under "More candidates" mention the subject themselves, a good sign they cover its own part.
- If an important theme has no fitting candidate, add a short Wikipedia search query for it under "search".
- Say what the topic's articles are mostly about, as "kind": "people" (people and their relations), "family" (a dynasty or family), "events" (wars, revolutions, a chain of events), "places", "works" (books, music, art, films), "ideas" (science, religion, philosophy, concepts), or "mixed" if none of these clearly dominates.

- Write the topic name, theme names and "why" sentences in {{ANSWER_LANGUAGE}}.

Reply with exactly this JSON shape:
{"name": "short topic name", "kind": "people", "facets": [{"name": "theme name", "why": "one short sentence", "pages": [1, 2, 3]}], "search": [{"facet": "theme name", "query": "search words"}]}
```

### Where each value comes from

| Placeholder | Source | World War I value |
|---|---|---|
| `{{TITLE}}` | Wikipedia's title, from call #1 | `World War I` |
| `{{INTRO}}` | The article's intro from call #1, first 2,400 characters | "World War I, or the First World War…" |
| `{{OUTLINE}}` | Section paths from call #1, joined with `; `, first 800 characters | `Introduction; Names; Background › Political and military alliances; …` |
| `{{WORDS}}` | Word count of the article, rounded to the nearest 100 | `13200` |
| `{{SIZE}}` | Over 8,000 words: "a long article, so likely a broad subject". Under 1,500: "a short article, so likely a narrow subject". Otherwise: "a medium-length article" | The long version |
| `{{CATEGORIES}}` | The open page's category list, first 15. The whole line is left out if there are none | `World War I; World wars; …` |
| `{{CANDIDATE_COUNT}}` | Candidates left after step 5 | `151` |
| `{{CANDIDATE_LINES}}` | One line per candidate, see below | 151 lines |
| `{{EXTRA_LIST}}` | Extras from step 5, as `152. Title; 153. Title; …`. The whole block is left out if there are none | 407 names |
| `{{ANSWER_LANGUAGE}}` | Settings › Answer language, see below | `English` |

**A candidate line** looks like this:

```
{{N}}. {{ARTICLE}} — {{WHERE, first 110 characters}} [{{TAGS}}]
2. Spanish flu — The war also contributed to the spread of the Spanish flu pandemic. … The living conditions led to disease and [main, navbox, back]
```

- **`WHERE`:** the sentences or labels from step 1, or the section names if there are none.
- **`TAGS`:** the signals from step 1 without `hatnote`, plus `back` from step 5.

**`{{ANSWER_LANGUAGE}}`** depends on the setting:

| Answer language setting | Language used in this prompt |
|---|---|
| My language, from the browser (default) | The browser's language |
| Same as the Wikipedia article | The article's language |
| A specific language | That language |
| Same as my question | The article's language, because a build has no question to follow |

The code is turned into an English name, such as `de` to `German`, because models follow those most reliably.

**Other fixed values:** "never more than 60" is `MAX_PAGES` in `lib/cluster.js`.

### The model's reply

The model answers by number, and the app turns those numbers back into titles:

```json
{
  "name": "World War I",
  "kind": "events",
  "facets": [
    {"name": "Origins and Diplomacy", "why": "These articles cover the political tensions…", "pages": [16, 17, 18, 44, 212]}
  ],
  "search": [{"facet": "Society and Impact", "query": "social impact of World War I on women"}]
}
```

`planShape` cleans this up: anything malformed is fixed or dropped, and an unknown `kind` becomes `mixed`.

### The fuller-topic follow-up

If this check runs, the original prompt is sent again, followed by the model's plan as JSON and this message:

```
That is only {{PICKS}} articles for a broad subject. Add the central candidates you left out (people, events, ideas, consequences), aiming for 35 to 50 in all. Reply with the whole JSON object again.
```

The fuller plan is only used if it has more picks. If the request fails, the original plan stands.

The full World War I request and reply are in `test/fixtures/ww1-model-request.txt`, which is gitignored and only on your machine.

## Why there's no type check here

The Wikidata type check isn't part of a build, because **nothing in the build uses it**:

- **What it's for:** the panel runs it when it opens, to choose the "Try asking" questions. The result stays in the panel (`state.pageType`) and isn't included in the data sent to the service worker.
- **What the build does instead:** the model works out the subject itself. The prompt describes the expected themes ("an event → causes, course, key people, consequences") and asks it to report a `kind`. In this log it replied `events`.
- **Why it isn't in your log:** the call does still happen on a topic-build page, but when the panel opens, before you click Build. It's also cached for 24 hours.

These are also two different labels:

| | Wikidata type | Topic `kind` |
|---|---|---|
| Describes | One article | The group of articles |
| Values | person, place, event, work, religion, group, concept, other | people, family, events, places, works, ideas, mixed |
| Decided by | Wikidata's data | The model |
| Used for | "Try asking" questions in an article chat | "Try asking" questions in a topic chat |

Every template and rule is in [how the "Try asking" questions are generated](ARTICLE_CHAT.md#how-the-try-asking-questions-are-generated).

It could be passed in, to tell the model "this article is about an event" at no extra cost, but the model already got this one right.

## Timing in this log

| Part | Time |
|---|---|
| Model (#17) | 6.4s |
| Wikipedia calls | 5.5s of waiting, 7.6s if added up, because some overlap |
| Total | About 12s |

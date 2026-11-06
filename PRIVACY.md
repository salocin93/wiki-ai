# Wiki AI privacy policy

Last updated: 2026-11-03

Wiki AI is a browser extension that answers questions about the Wikipedia article you are reading. This policy explains what data it handles, where that data goes, and how to delete it.

**Summary.** The developer of Wiki AI runs no servers and receives none of your data. To answer a question, the extension sends your question and Wikipedia text to the AI service you choose in the settings. Everything else stays in your browser.

## What is sent, and to whom

When you ask a question, Wiki AI sends the following to the AI service set in the extension's settings:

- your question;
- any text you selected on the page and asked about;
- the earlier questions and answers in the same chat;
- passages from the Wikipedia article you're reading and from articles it links to, and the name of the section you're looking at;
- your API key for that service, which identifies your account to it.

By default this service is **Google's Gemini API** (`generativelanguage.googleapis.com`). If you choose "Other provider", it goes to the address you enter instead, for example a model running on your own computer.

If you switch on the experimental **Semantic search** setting (off by default), the text of the articles you ask about is also sent to the embedding service, which is Gemini's embedding model unless you enter another address in the settings, so that passages can be matched to your question by meaning. The same terms apply as above.

How that service handles the data is governed by its own terms and privacy policy. For Gemini, see Google's [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms) and the [Google Privacy Policy](https://policies.google.com/privacy). **On Gemini's free tier, Google may use what you send to improve its products, and human reviewers may read it.** Don't ask about anything you want to keep private.

Wiki AI also requests articles, summaries and image details from Wikipedia (`*.wikipedia.org`), the same way your browser does when you read Wikipedia. These requests contain article titles and, sometimes, search words chosen to find related articles. When you open the sidebar on an article, Wiki AI also asks Wikidata (`query.wikidata.org`, also run by the Wikimedia Foundation) what kind of subject the article is about (a person, a place, an event …) and for facts about that subject, to suggest fitting questions. Those requests contain only the article's Wikidata identifier and, for the facts, its Wikipedia's language. None of these requests contain your questions verbatim or your API key. See the [Wikimedia Foundation privacy policy](https://foundation.wikimedia.org/wiki/Policy:Privacy_policy).

Wiki AI has no analytics, no tracking and no advertising. It doesn't sell or share data with anyone else.

## What is stored in your browser

| Data | Kept for |
|---|---|
| Settings, including your API key(s), stored unencrypted in the extension's storage | Until you change them or remove the extension |
| Your chats: questions, answers, and the Wikipedia passages they cite | Until you delete them. At most 12 chats per article or topic and 40 articles or topics; the oldest are removed first |
| Topic clusters you build: article titles, themes, short descriptions | Until you delete them. At most 50; the oldest are removed first |
| Copies of Wikipedia articles, to avoid downloading them again | 24 hours |
| Embedding vectors of article sections, if you switch on Semantic search (numbers, not text) | 7 days |
| Whether the sidebar is open in a tab | Until you close the tab |

This data stays on your device. Wiki AI doesn't sync it to other devices.

## Deleting your data

- **One chat:** the × next to it in the sidebar's History.
- **One topic and its chats:** the × next to the topic.
- **Everything except your settings:** Settings › Storage › *Delete all topics and chats*, and *Clear article cache*.
- **Your API key:** clear the key field in Settings.
- **Everything:** remove the extension (`chrome://extensions`).

Data already sent to the AI service is handled under that service's policy; Wiki AI can't delete it there.

## Permissions

- **Wikipedia sites:** to show the sidebar on articles and read articles for answers.
- **query.wikidata.org:** to look up what kind of subject an article is about and facts about that subject, for suggested questions.
- **generativelanguage.googleapis.com:** to reach the default AI service.
- **Other sites (optional, asked when you test a connection):** only the address of the AI service you enter yourself.
- **Storage:** to keep your settings, chats and topics.
- **Context menus:** for "Ask Wiki AI about …" on selected text.

## Use of data (Chrome Web Store Limited Use)

Wiki AI uses the data described here only to provide its single purpose: answering your questions about Wikipedia articles. It doesn't transfer data to anyone except the AI service you chose, and only to get an answer. It doesn't use or transfer data for advertising, credit decisions, or any purpose unrelated to that feature. No person working on Wiki AI reads your data.

## Children

Wiki AI is not directed at children under 13 and doesn't knowingly collect their data.

## Changes

Changes to this policy are published at this address, with a new "Last updated" date.

## Contact

Questions about this policy: <CONTACT EMAIL>, or open an issue at https://github.com/salocin93/wiki-ai.

Wiki AI is an independent project, not affiliated with, endorsed by or sponsored by Wikipedia or the Wikimedia Foundation.

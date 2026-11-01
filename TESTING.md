# Testing Wiki AI

Wiki AI adds a chat panel to Wikipedia. Ask about the article you're reading and the articles it links to, build a "topic cluster" to explore a subject across many articles, and see it as a map.

## Install (Chrome, about 5 minutes)

1. Unzip `wiki-ai-<version>.zip`. You get a folder called `wiki-ai`.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `wiki-ai` folder.
4. The settings page opens. Under **Where answers come from**, choose **Google Gemini (free API key)**.
5. Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey): sign in with a Google account, then **Create API key**. Paste it into **API key**.
6. Click **Test connection**, then **Save**.

Keep the `wiki-ai` folder where it is; Chrome loads the extension from it.

## Try it

- Open any Wikipedia article and click the round chat button (bottom right), or press **Alt+Shift+W**.
- **Chat**: ask a question. Numbers like `[3]` are sources; click one to jump to the passage. Suggested follow-up questions appear under each answer.
- Select text in the article and click **Ask about this**.
- **Topic**: **Build topic cluster** groups the article's most relevant links into themes. Answers then search all of them.
- **Map**: the topic's articles as a graph. Click an article for its summary.
- **History**: all your chats, across articles and topics.

## Good to know

- Free Gemini keys have rate limits. If you ask many questions quickly, the panel waits and retries ("Rate limit reached, trying again in … s").
- On Google's free tier, Google may use your requests to improve its products. Don't paste anything private.
- Answers are checked against the Wikipedia passages the model read. Anything that couldn't be matched, like a date or name from the model's own memory, is underlined; hover over it to see why.
- Your chats and topics are stored only in your browser. The trash button at the top of the panel deletes all of them, to start a test over (your settings and key stay).

## Feedback

Note the article, what you asked, what you expected and what happened. A screenshot of the panel helps most.

// The records passed between the service worker, the panel and storage. Used in JSDoc (`@param {Source} src`);
// checked by `npm run typecheck`.

/** An image from the article, with what Wikimedia Commons says about the file. */
interface Figure {
  path: string; // section path
  file: string;
  caption: string;
  description?: string;
  categories?: string[];
  artist?: string;
  license?: string;
  thumb?: string;
  url?: string; // the file's Commons page
}

/** A passage of an article as indexed for search (about 160 words, or one table, infobox or image). */
interface Chunk {
  lang: string;
  page: string;
  section: string; // "History › Early years"
  text: string;
  revid?: number; // the revision it was read from
  figure?: Figure;
}

/** A passage shown to the model, numbered once per chat; answers cite it as [n]. */
interface Source {
  n: number;
  key: string;
  lang: string;
  page: string;
  section: string;
  text: string; // blanked in saved chats when no answer cites it
  current?: boolean; // from the article the reader is on
  revid?: number;
  figure?: Figure;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  steps?: string[];
  followups?: string[];
  unsupported?: { text: string; note: string; kind: 'missing' | 'miscited' | 'uncited' }[];
  model?: string;
  error?: string;
}

/** A chat, saved per scope ("page:<lang>:<title>" or "topic:<id>"). */
interface Conv {
  id: string;
  scope?: string;
  title: string;
  messages: Message[];
  sources: Source[];
  parentId?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface TopicPage {
  title: string;
  facet: string | null; // the theme; null for the starting article
  why: string;
  seed?: boolean;
  description?: string;
  summary?: string;
}

/** A topic cluster: linked articles grouped into themes, with the links between them. */
interface Topic {
  id: string;
  name: string;
  lang: string;
  seed: string;
  createdAt: number;
  updatedAt?: number;
  facets: { name: string; why: string }[];
  pages: TopicPage[];
  edges: [string, string][];
}

interface Settings {
  provider: string;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  apiKey: string;
  apiKeys: Record<string, string>;
  connections: Record<string, { baseUrl: string; model: string; fallbackModel: string }>;
  contextTokens: number;
  maxAnswerTokens: number;
  temperature: number;
  maxSteps: number;
  disableThinking: boolean;
  verifyCitations: boolean;
  answerLanguage: string;
  answerLanguageChosen: boolean;
}

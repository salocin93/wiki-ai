// Small BM25 keyword index. Good enough for encyclopedia prose and needs no model.
const STOP = new Set(
  ('a an and are as at be been but by can did do does for from had has have he her his how i if in into is it its ' +
    'me my of on or our she so than that the their them then there these they this those to was we were what when ' +
    'where which who whom why will with would you your about after also any before between both during each more ' +
    'most other over same some such through under until very while tell explain describe ' +
    // Words that rate the subject rather than name it: in "best known for" they match any passage with "best".
    'best known famous important importance notable significant significance main key well overview summary')
    .split(' ')
);

function stem(t) {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function tokenize(text) {
  const words = (text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!words) return [];
  return words.filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

class BM25 {
  // docs: array of items; textOf(item) returns the searchable text.
  constructor(docs, textOf, { k1 = 1.4, b = 0.75 } = {}) {
    this.docs = docs;
    this.k1 = k1;
    this.b = b;
    this.tf = [];
    this.len = [];
    this.df = new Map();
    for (const doc of docs) {
      const counts = new Map();
      const tokens = tokenize(textOf(doc));
      for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      this.tf.push(counts);
      this.len.push(tokens.length);
    }
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / Math.max(1, docs.length);
  }

  search(query, k = 5) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const N = this.docs.length;
    const scored = [];
    for (let i = 0; i < N; i++) {
      let score = 0;
      for (const t of terms) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        const df = this.df.get(t);
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avgLen));
      }
      if (score > 0) scored.push({ doc: this.docs[i], score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}

export const bm25 = { BM25, tokenize };

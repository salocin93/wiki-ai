// Does Gemini's free-tier embedding limit count calls or texts?
//   GEMINI_API_KEY=… node test/embed-quota-check.mjs gemini-embedding-2
//   GEMINI_API_KEY=… node test/embed-quota-check.mjs gemini-embedding-001
// Sends two batches of 100 short texts back to back, then one single text. The free limit is 100 a minute:
//   both batches succeed          → it counts CALLS: batching is the lever (embed 100 sections per call, ~1,000 calls a day)
//   the second batch gets a 429   → it counts TEXTS: batching saves nothing
// Spends up to ~200 requests of that model's daily quota; wait a minute before running it again.
//
// Cheaper, if you can read request counts on the AI Studio usage dashboard:
//   GEMINI_API_KEY=… node test/embed-quota-check.mjs gemini-embedding-2 --probe=7
// Sends ONE call with 7 texts (use any number from 2 to 20) and stops. Then look at the model's request count on the dashboard
// (it can lag a few minutes; run it when nothing else is using that model):
//   it went up by 1  → the limit counts CALLS
//   it went up by 7  → the limit counts TEXTS
const model = process.argv[2] || 'gemini-embedding-2';
const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error('Set GEMINI_API_KEY.');
  process.exit(1);
}
const v2 = /^gemini-embedding-2/.test(model);
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;

async function call(label, n) {
  const requests = Array.from({ length: n }, (_, i) => ({
    model: `models/${model}`,
    content: { parts: [{ text: v2 ? `title: none | text: quota check ${label} ${i}` : `quota check ${label} ${i}` }] },
    outputDimensionality: 768,
    ...(v2 ? {} : { taskType: 'RETRIEVAL_DOCUMENT' }),
  }));
  const t0 = Date.now();
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ requests }) });
  const text = await res.text();
  let note = '';
  if (!res.ok) {
    try {
      const e = JSON.parse(text).error;
      const metric = e.details?.find((d) => d.violations)?.violations?.[0];
      note = ` ${e.message.split('\n')[0].slice(0, 90)} | ${metric?.quotaId || ''} limit ${metric?.quotaValue || '?'}`;
    } catch {
      note = ` ${text.slice(0, 120)}`;
    }
  } else {
    note = ` ${JSON.parse(text).embeddings?.length} embeddings, ${Math.round((JSON.parse(text).embeddings?.[0]?.values?.length || 0))} dims`;
  }
  console.log(`${label.padEnd(10)} ${String(n).padStart(3)} texts → ${res.status} in ${Date.now() - t0} ms${note}`);
  return res.status;
}

const probe = Number(process.argv.find((a) => a.startsWith('--probe='))?.slice(8));
console.log(`model: ${model}\n`);
if (probe >= 2 && probe <= 20) {
  await call('probe', probe);
  console.log(`\nNow check the dashboard's request count for ${model}: +1 means calls are counted, +${probe} means texts are.`);
  process.exit(0);
}
const a = await call('batch A', 100);
const b = await call('batch B', 100);
const c = await call('single', 1);
console.log(
  a === 200 && b === 200
    ? '\nBoth batches of 100 went through within a minute: the limit counts CALLS. Batching is the lever.'
    : a === 200 && b === 429
      ? '\nThe second batch was refused: the limit counts TEXTS (batch A used the minute\'s 100). Batching saves nothing.'
      : `\nUnexpected: A ${a}, B ${b}, single ${c}. Check the messages above.`
);

// Small helpers for waiting and for doing several things at once, shared by the Wikipedia, model and embedding clients.

// Resolves after ms, or rejects as soon as signal aborts.
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason || new Error('Aborted'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// Runs fn(item, index) over items, at most `limit` at a time; the results come back in the items' order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const asyncUtil = { sleep, mapLimit };

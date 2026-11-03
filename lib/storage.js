// chrome.storage.local in the extension, memory elsewhere (Node tests, the page harness), with writes to a key
// queued one after another: the service worker handles several tabs' messages at once, and two read-modify-writes
// of the same list would otherwise overwrite each other.
(function (g) {
  const W = (g.WikiAI = g.WikiAI || {});
  const memory = {};
  const local = () => g.chrome?.storage?.local;

  async function get(key) {
    if (local()) return (await local().get(key))[key];
    return memory[key];
  }

  async function set(key, value) {
    if (local()) await local().set({ [key]: value });
    else memory[key] = value;
  }

  async function remove(key) {
    if (local()) await local().remove(key);
    else delete memory[key];
  }

  // Bytes used by the whole area (an estimate outside the extension).
  async function bytesInUse() {
    if (local()?.getBytesInUse) return local().getBytesInUse(null);
    return JSON.stringify(memory).length;
  }

  // Runs fn after every earlier fn queued under the same name has finished, failed or not.
  const queues = new Map();
  function locked(name, fn) {
    const run = (queues.get(name) || Promise.resolve()).then(fn);
    const settled = run.catch(() => {});
    queues.set(name, settled);
    settled.then(() => queues.get(name) === settled && queues.delete(name));
    return run;
  }

  W.storage = { get, set, remove, bytesInUse, locked };
})(globalThis);

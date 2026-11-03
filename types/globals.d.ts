// Globals the extension's scripts share. There is no bundler: each file adds itself to globalThis.WikiAI, and
// chrome.* comes from the browser. The shapes of the data passed around are in data.d.ts.
declare var WikiAI: any;
declare var chrome: any;
declare var katex: any;
declare function importScripts(...urls: string[]): void;

interface Window {
  __wikiai?: boolean; // the content script ran in this page already
  __wikiaiRoot?: ShadowRoot; // the panel's shadow root, for the test harness
}

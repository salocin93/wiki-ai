// Globals from the browser that the scripts use. The modules import each other; chrome.* and KaTeX (loaded on
// demand) are globals. The shapes of the data passed around are in data.d.ts.
declare var chrome: any;
declare var katex: any;
declare function importScripts(...urls: string[]): void;

interface Window {
  __wikiai?: boolean; // the content script ran in this page already
  __wikiaiRoot?: ShadowRoot; // the panel's shadow root, for the test harness
}

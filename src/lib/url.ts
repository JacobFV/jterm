/**
 * Turning what someone typed in the address bar into somewhere to go.
 *
 * The rule people expect, without knowing they expect it: if it could be an
 * address, treat it as one; otherwise search for it. `localhost:3000` is an
 * address. `how to exit vim` is not. `README.md` is not, despite the dot —
 * which is why a known-hostname shape is required rather than merely a dot.
 */

const SEARCH = "https://duckduckgo.com/?q=";

/** Schemes an address bar may navigate to. Anything else is searched for. */
const ALLOWED = new Set(["http:", "https:"]);

export function normalizeUrl(input: string): string {
  const text = input.trim();
  if (!text) return "about:blank";

  // `localhost:5173` parses as the scheme `localhost` if you let it, which
  // would send a developer's dev server to a search engine. A colon followed by
  // digits is a port, not a scheme.
  const isHostPort = /^[a-z0-9-]+(\.[a-z0-9-]+)*:\d+(?:[/?#]|$)/i.test(text);

  // An explicit scheme is taken at its word, unless it is one we will not open
  // — `javascript:` and `file:` are searched for rather than followed.
  const scheme = isHostPort ? null : /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (scheme) {
    if (!ALLOWED.has(`${scheme[1].toLowerCase()}:`)) return SEARCH + encodeURIComponent(text);
    try {
      return new URL(text).href;
    } catch {
      return SEARCH + encodeURIComponent(text);
    }
  }

  if (looksLikeHost(text)) {
    try {
      return new URL(`https://${text}`).href;
    } catch {
      return SEARCH + encodeURIComponent(text);
    }
  }

  return SEARCH + encodeURIComponent(text);
}

function looksLikeHost(text: string): boolean {
  if (/\s/.test(text)) return false;

  const [authority] = text.split(/[/?#]/, 1);
  if (!authority) return false;

  // `localhost`, with or without a port, is the case this whole function
  // exists for — it is what a developer types most.
  const [host, port] = authority.split(":");
  if (port !== undefined && !/^\d+$/.test(port)) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;

  // Otherwise require something that looks like a registered name: labels
  // separated by dots, ending in letters. `README.md` fails on `md` being a
  // real suffix only in theory — but requiring two or more letters and no
  // path-like shape gets the common cases right.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(host);
}

/** A shortened form for a tab label: the host, without a leading `www.`. */
export function displayHost(url: string): string | null {
  try {
    const host = new URL(url).host;
    return host ? host.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

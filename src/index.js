// src/index.js
// Digg RSS Worker — external-first + optional "Discuss on Digg" + TL;DR from Digg HTML

// =========================
// Helpers
// =========================

function clampInt(v, fallback, min, max) {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Prevent accidentally closing CDATA blocks
function cdataSafe(s) {
  return String(s || "").replaceAll("]]>", "]]&gt;");
}

function makeSnippet(text, maxLen = 220) {
  if (!text) return "";
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const truncated = clean.slice(0, maxLen);
  const cut = truncated.lastIndexOf(" ");
  return (cut > 40 ? truncated.slice(0, cut) : truncated) + "…";
}

// Decode Digg HTML entities → real punctuation
function decodeHtmlEntities(input) {
  if (!input) return "";
  let s = String(input);

  const named = {
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&nbsp;": " ",
  };

  s = s.replace(
    /&quot;|&apos;|&#39;|&amp;|&lt;|&gt;|&nbsp;/g,
    (m) => named[m] ?? m
  );

  s = s.replace(/&#(\d+);/g, (_, n) => {
    try { return String.fromCodePoint(Number(n)); } catch { return _; }
  });

  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
    try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; }
  });

  return s;
}

function extractMetaContent(html, key, isProperty = false) {
  const attr = isProperty ? "property" : "name";
  const re = new RegExp(
    `<meta[^>]+${attr}\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[1]) : "";
}

// =========================
// YouTube helpers
// =========================

function isValidYouTubeId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{10,16}$/.test(id);
}

function getYouTubeVideoId(urlStr) {
  if (!urlStr) return null;
  let u;
  try { u = new URL(urlStr); } catch { return null; }

  const host = u.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return isValidYouTubeId(id) ? id : null;
  }

  if (host.endsWith("youtube.com")) {
    const v = u.searchParams.get("v");
    if (isValidYouTubeId(v)) return v;

    const parts = u.pathname.split("/").filter(Boolean);
    if (["shorts", "embed", "live"].includes(parts[0]) && isValidYouTubeId(parts[1])) {
      return parts[1];
    }
  }

  return null;
}

function youtubeThumbUrl(id) {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

// =========================
// TL;DR fetch from Digg HTML
// =========================

async function fetchDiggTldr(diggLink, tldrMax, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`${diggLink}#tldr=${tldrMax}`);

  const cached = await cache.match(cacheKey);
  if (cached) return (await cached.text()) || "";

  let html = "";
  try {
    const r = await fetch(diggLink, {
      headers: {
        accept: "text/html,*/*",
        "user-agent": "3HPM-DiggRSS/1.0 (+https://3holepunchmedia.ca)"
      }
    });
    if (!r.ok) return "";
    html = await r.text();
  } catch {
    return "";
  }

  const og = extractMetaContent(html, "og:description", true);
  const meta = extractMetaContent(html, "description", false);

  const raw = og || meta || "";
  const snippet = raw ? makeSnippet(raw, tldrMax) : "";

  const out = new Response(snippet, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" }
  });

  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return snippet;
}

// =========================
// RSS Builder
// =========================

function buildRss({ title, link, description, items }) {
  const now = new Date().toUTCString();

  const itemXml = items.map(it => {
    const enclosure = it.enclosure
      ? `\n    <enclosure url="${escapeXml(it.enclosure.url)}" type="${it.enclosure.type}" length="0" />`
      : "";

    return `
  <item>
    <title><![CDATA[${cdataSafe(it.title)}]]></title>
    <link>${escapeXml(it.link)}</link>
    <guid isPermaLink="true">${escapeXml(it.guid)}</guid>
    <pubDate>${new Date(it.pubDate).toUTCString()}</pubDate>
    <description><![CDATA[${cdataSafe(it.description)}]]></description>${enclosure}
  </item>`.trim();
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title><![CDATA[${cdataSafe(title)}]]></title>
  <link>${escapeXml(link)}</link>
  <description><![CDATA[${cdataSafe(description)}]]></description>
  <ttl>10</ttl>
  <lastBuildDate>${now}</lastBuildDate>
${itemXml}
</channel>
</rss>`;
}

// =========================
// Worker
// =========================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;

    if (path.startsWith("/rss/digg/")) {
      path = path.replace("/rss/digg/", "/rss/");
    }

    const isAll = path === "/rss/all-digg-trending.xml";
    const m = path.match(/^\/rss\/([a-z0-9-]+)\.xml$/i);
    const communitySlug = !isAll && m ? m[1].toLowerCase() : null;

    if (!isAll && !communitySlug) {
      return new Response("Not found", { status: 404 });
    }

    const limit = clampInt(url.searchParams.get("limit"), 10, 1, 50);
    const tldrMax = clampInt(url.searchParams.get("tldr"), 220, 80, 500);

    const gqlQuery = `
query PostsQuery($first: Int, $where: PostWhere, $sort: PostSort) {
  posts(first: $first, where: $where, sort: $sort) {
    edges {
      node {
        _id
        title
        slug
        createdDate
        externalContent { url }
        community { slug }
      }
    }
  }
}`.trim();

    const endpoint = "https://apineapple-prod.digg.com/graphql";

    const payload = {
      operationName: "PostsQuery",
      query: gqlQuery,
      variables: {
        first: limit,
        sort: "TOP_N",
        where: isAll ? {} : { communitySlug }
      }
    };

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "3HPM-DiggRSS/1.0 (+https://3holepunchmedia.ca)"
      },
      body: JSON.stringify(payload)
    });

    const json = await resp.json();
    const edges = json?.data?.posts?.edges || [];

    const items = await Promise.all(edges.map(async ({ node }) => {
      const comm = node.community?.slug || "digg";
      const diggLink = `https://digg.com/${comm}/${node._id}/${node.slug}`;
      const externalUrl = node.externalContent?.url || "";

      const tldr = await fetchDiggTldr(diggLink, tldrMax, ctx);
      const base = tldr || node.title || "";
      const text = makeSnippet(decodeHtmlEntities(base), tldrMax);

      const description = externalUrl
        ? `${text}<br/><br/><a href="${diggLink}">Discuss on Digg</a>`
        : text;

      const yt = getYouTubeVideoId(externalUrl || diggLink);

      return {
        title: decodeHtmlEntities(node.title || "(untitled)"),
        link: externalUrl || diggLink,
        guid: diggLink,
        pubDate: node.createdDate,
        description,
        enclosure: yt ? { url: youtubeThumbUrl(yt), type: "image/jpeg" } : null
      };
    }));

    const feedTitle = isAll
      ? "Digg — All Digg"
      : `Digg — ${communitySlug} (Newest)`;

    const rss = buildRss({
      title: feedTitle,
      link: isAll ? "https://digg.com" : `https://digg.com/${communitySlug}`,
      description: feedTitle,
      items
    });

    return new Response(rss, {
      headers: {
        "content-type": "application/rss+xml; charset=utf-8",
        "cache-control": "public, max-age=600"
      }
    });
  }
};

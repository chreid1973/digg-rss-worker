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

// Prevent accidentally closing CDATA blocks inside RSS
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

function decodeHtmlEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x60;/g, "`")
    .replace(/&#x3D;/g, "=");
}

function extractMetaContent(html, key, isProperty = false) {
  // key example: "og:description" or "description"
  // Looks for: <meta property="og:description" content="...">
  //        or: <meta name="description" content="...">
  const attr = isProperty ? "property" : "name";
  const re = new RegExp(
    `<meta[^>]+${attr}\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[1]) : "";
}

// =========================
// YouTube thumbnail helpers
// =========================

function isValidYouTubeId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{10,16}$/.test(id);
}

function getYouTubeVideoId(urlStr) {
  if (!urlStr) return null;
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }

  const host = (u.hostname || "").replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return isValidYouTubeId(id) ? id : null;
  }

  if (host.endsWith("youtube.com")) {
    const v = u.searchParams.get("v");
    if (isValidYouTubeId(v)) return v;

    const parts = (u.pathname || "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      const kind = parts[0];
      const id = parts[1];
      if ((kind === "shorts" || kind === "embed" || kind === "live") && isValidYouTubeId(id)) {
        return id;
      }
    }
  }

  return null;
}

function youtubeThumbUrl(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// =========================
// TL;DR fetch from Digg post HTML
// =========================

async function fetchDiggTldr(diggLink, tldrMax, ctx) {
  // Cache per-post TL;DR so we don't hammer Digg
  const cache = caches.default;
  const cacheKey = new Request(`${diggLink}#tldr=${tldrMax}`, { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) {
    const txt = await cached.text().catch(() => "");
    return txt || "";
  }

  let html = "";
  try {
    const resp = await fetch(diggLink, {
      headers: {
        "accept": "text/html,*/*",
        "user-agent": "3HPM-DiggRSS/1.0 (+https://3holepunchmedia.ca)"
      }
    });
    if (!resp.ok) return "";
    html = await resp.text();
  } catch {
    return "";
  }

  // Prefer og:description, then meta description
  const og = extractMetaContent(html, "og:description", true);
  const meta = extractMetaContent(html, "description", false);

  const raw = (og || meta || "").trim();
  const clipped = raw ? makeSnippet(raw, tldrMax) : "";

  // Store plain text in cache
  const out = new Response(clipped, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" }
  });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));

  return clipped;
}

// =========================
// RSS Builder
// =========================

function buildRss({ title, link, description, items }) {
  const now = new Date().toUTCString();

  const itemXml = (items || [])
    .map((it) => {
      const enclosureXml = it.enclosure
        ? `\n    <enclosure url="${escapeXml(it.enclosure.url)}" type="${escapeXml(
            it.enclosure.type
          )}" length="0" />`
        : "";

      return `
  <item>
    <title><![CDATA[${cdataSafe(it.title)}]]></title>
    <link>${escapeXml(it.link)}</link>
    <guid isPermaLink="true">${escapeXml(it.guid)}</guid>
    <pubDate>${new Date(it.pubDate).toUTCString()}</pubDate>
    <description><![CDATA[${cdataSafe(it.description)}]]></description>${enclosureXml}
  </item>`.trim();
    })
    .join("\n");

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
    try {
      const url = new URL(request.url);
      let pathname = url.pathname;

      if (pathname.startsWith("/rss/digg/")) {
        pathname = pathname.replace("/rss/digg/", "/rss/");
      }

      const isAll = pathname === "/rss/all-digg-trending.xml";
      const m = pathname.match(/^\/rss\/([a-z0-9-]+)\.xml$/i);
      const communitySlug = !isAll && m ? m[1].toLowerCase() : null;

      if (!isAll && !communitySlug) {
        return new Response("Not found", { status: 404 });
      }

      const limit = clampInt(url.searchParams.get("limit"), 10, 1, 50);

      // TL;DR length: default 220, allow override
      const tldrMax = clampInt(url.searchParams.get("tldr"), 220, 80, 500);

      const gqlQuery = `
query PostsQuery($first: Int, $after: String, $where: PostWhere, $sort: PostSort) {
  posts(first: $first, after: $after, where: $where, sort: $sort) {
    edges {
      node {
        _id
        title
        slug
        createdDate
        externalContent { url }
        community { name slug }
      }
    }
  }
}`.trim();

      // Cache RSS by URL
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const endpoint = "https://apineapple-prod.digg.com/graphql";

      const windowsMs = isAll
        ? [24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000]
        : [24 * 60 * 60 * 1000, 72 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];

      let edges = null;
      let lastErr = null;

      for (const windowMs of windowsMs) {
        const since = new Date(Date.now() - windowMs).toISOString();

        const whereVariants = isAll
          ? [{ createdDate_GT: since }]
          : [
              { createdDate_GT: since, communitySlug },
              { createdDate_GT: since, communitySlug_EQ: communitySlug },
              { createdDate_GT: since, community: { slug: communitySlug } },
              { createdDate_GT: since, community: { slug_EQ: communitySlug } }
            ];

        for (const where of whereVariants) {
          const payload = {
            operationName: "PostsQuery",
            query: gqlQuery,
            variables: { first: limit, after: null, sort: "TOP_N", where }
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

          const json = await resp.json().catch(() => ({}));

          if (resp.ok && json?.data?.posts?.edges && !json?.errors) {
            const candidate = json.data.posts.edges;

            if (candidate.length >= Math.min(limit, 5)) {
              edges = candidate;
              break;
            }

            if (!edges || candidate.length > edges.length) {
              edges = candidate;
            }
          } else {
            lastErr = json?.errors || json || { status: resp.status };
          }
        }

        if (edges && edges.length >= Math.min(limit, 5)) break;
      }

      if (!edges) {
        return new Response("Upstream error: " + JSON.stringify(lastErr || {}), {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }

      // Build items with TL;DR from Digg HTML
      const items = await Promise.all(
        edges.map(async ({ node }) => {
          const comm = node.community?.slug || "digg";
          const rawId = String(node._id || "");
          const shortId = rawId.startsWith(comm + "-") ? rawId.slice((comm + "-").length) : rawId;

          const diggLink = `https://digg.com/${comm}/${shortId}/${node.slug}`;
          const externalUrl = node.externalContent?.url || "";

          // External-first behavior:
          // - If external exists: RSS <link> goes to external
          // - Else: RSS <link> goes to Digg
          const link = externalUrl || diggLink;

          // TL;DR: pull from Digg post page; fallback to title snippet
          const tldr = await fetchDiggTldr(diggLink, tldrMax, ctx);
          const baseText = tldr || node.title || "";
          const baseSnippet = makeSnippet(baseText, tldrMax);

          // Description:
          // - If external exists: include "Discuss on Digg"
          // - Else: just the snippet
          const description = externalUrl
            ? `${escapeXml(baseSnippet)}<br/><br/><a href="${escapeXml(diggLink)}">Discuss on Digg</a>`
            : escapeXml(baseSnippet);

          // YouTube enclosure from external first (fallback to diggLink)
          const ytId = getYouTubeVideoId(externalUrl || diggLink);
          const enclosure = ytId ? { url: youtubeThumbUrl(ytId), type: "image/jpeg" } : null;

          return {
            title: node.title || "(untitled)",
            link,
            guid: diggLink,
            pubDate: node.createdDate,
            description,
            enclosure
          };
        })
      );

      const feedTitle = isAll ? "Digg — All Digg" : `Digg — ${communitySlug} (Newest)`;
      const feedLink = isAll ? "https://digg.com/?feed=all-digg" : `https://digg.com/${communitySlug}`;

      const rss = buildRss({
        title: feedTitle,
        link: feedLink,
        description: feedTitle,
        items
      });

      const out = new Response(rss, {
        headers: {
          "content-type": "application/rss+xml; charset=utf-8",
          "cache-control": "public, max-age=600"
        }
      });

      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    } catch (err) {
      return new Response("Worker error: " + (err?.stack || err?.message || String(err)), {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }
  }
};

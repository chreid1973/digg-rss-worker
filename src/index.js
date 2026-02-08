// src/index.js
// Digg RSS Worker (external-first)
// - <link> points to external URL when present, otherwise the Digg post
// - If external URL exists, <description> includes "Discuss on Digg"
// - YouTube enclosure is detected from external URL first (fallback to digg link)

function makeSnippet(text, maxLen = 220) {
  if (!text) return "";
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const truncated = clean.slice(0, maxLen);
  const cut = truncated.lastIndexOf(" ");
  return (cut > 40 ? truncated.slice(0, cut) : truncated) + "…";
}

// =========================
// YouTube thumbnail helpers
// =========================

function getYouTubeVideoId(urlStr) {
  if (!urlStr) return null;

  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }

  const host = (u.hostname || "").replace(/^www\./, "").toLowerCase();

  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return isValidYouTubeId(id) ? id : null;
  }

  // youtube.com / m.youtube.com / music.youtube.com
  if (host.endsWith("youtube.com")) {
    const path = u.pathname || "";

    // /watch?v=<id>
    const v = u.searchParams.get("v");
    if (isValidYouTubeId(v)) return v;

    // /shorts/<id> OR /embed/<id> OR /live/<id>
    const parts = path.split("/").filter(Boolean);
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

function isValidYouTubeId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{10,16}$/.test(id);
}

function youtubeThumbUrl(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// =========================
// Worker
// =========================

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      let pathname = url.pathname;

      // Back-compat: /rss/digg/<slug>.xml -> /rss/<slug>.xml
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
}
      `.trim();

      // Cache keyed only by URL
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });

      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const endpoint = "https://apineapple-prod.digg.com/graphql";

      // Try smaller window first for freshness; widen if low volume
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
            variables: { first: limit, sort: "TOP_N", where }
          };

          const resp = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "accept": "application/json",
              "user-agent": "3HPM-DiggRSS/1.0 (+https://3holepunchmedia.ca)"
            },
            body: JSON.stringify(payload)
          });

          const json = await resp.json().catch(() => ({}));

          if (resp.ok && json?.data?.posts?.edges && !json?.errors) {
            const candidate = json.data.posts.edges;

            // Good enough? stop early
            if (candidate.length >= Math.min(limit, 5)) {
              edges = candidate;
              break;
            }

            // Keep the best partial result so far
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
        return new Response("Upstream error: " + safeJson(lastErr, 2000), {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }

      const items = edges.map(({ node }) => {
        const comm = node.community?.slug || "digg";
        const rawId = String(node._id || "");
        const shortId = rawId.startsWith(comm + "-") ? rawId.slice((comm + "-").length) : rawId;

        const diggLink = `https://digg.com/${comm}/${shortId}/${node.slug}`;
        const externalUrl = node.externalContent?.url || "";

        // External-first: if external exists, that's the primary click target
        const link = externalUrl || diggLink;

        // Description: snippet + "Discuss on Digg" only when external exists
        const baseSnippet = makeSnippet(node.title || "");
        const description = externalUrl
          ? `${escapeXml(baseSnippet)}<br/><br/><a href="${escapeXml(diggLink)}">Discuss on Digg</a>`
          : escapeXml(baseSnippet);

        // YouTube thumb via <enclosure>
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
      });

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

// =========================
// RSS Builder
// =========================

function buildRss({ title, link, description, items }) {
  const now = new Date().toUTCString();

  const itemXml = (items || [])
    .map((it) => {
      const enclosureXml = it.enclosure
        ? `\n    <enclosure url="${escapeXml(it.enclosure.url)}" type="${escapeXml(it.enclosure.type)}" length="0" />`
        : "";

      // Prevent accidentally closing CDATA
      const safeTitle = String(it.title || "").replaceAll("]]>", "]]&gt;");
      const safeDesc = String(it.description || "").replaceAll("]]>", "]]&gt;");

      return `
  <item>
    <title><![CDATA[${safeTitle}]]></title>
    <link>${escapeXml(it.link)}</link>
    <guid isPermaLink="true">${escapeXml(it.guid)}</guid>
    <pubDate>${new Date(it.pubDate).toUTCString()}</pubDate>
    <description><![CDATA[${safeDesc}]]></description>${enclosureXml}
  </item>`.trim();
    })
    .join("\n");

  const safeChannelTitle = String(title || "").replaceAll("]]>", "]]&gt;");
  const safeChannelDesc = String(description || "").replaceAll("]]>", "]]&gt;");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title><![CDATA[${safeChannelTitle}]]></title>
  <link>${escapeXml(link)}</link>
  <description><![CDATA[${safeChannelDesc}]]></description>
  <ttl>10</ttl>
  <lastBuildDate>${now}</lastBuildDate>
${itemXml}
</channel>
</rss>`;
}

// =========================
// Utilities
// =========================

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clampInt(v, fallback, min, max) {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function safeJson(obj, maxLen) {
  let s = "";
  try {
    s = JSON.stringify(obj);
  } catch {
    s = String(obj);
  }
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

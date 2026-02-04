export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      let pathname = url.pathname;

      // If you ever use a route like /rss/digg/* on your domain, normalize it.
      if (pathname.startsWith("/rss/digg/")) {
        pathname = pathname.replace("/rss/digg/", "/rss/");
      }

      // Routes:
      //   /rss/all-digg-trending.xml         => sitewide trending
      //   /rss/<community>.xml               => community trending (technology, digg, entertainment, etc.)
      const isAll = pathname === "/rss/all-digg-trending.xml";
      const m = pathname.match(/^\/rss\/([a-z0-9-]+)\.xml$/i);
      const communitySlug = (!isAll && m) ? m[1].toLowerCase() : null;

      if (!isAll && !communitySlug) {
        return new Response("Not found", { status: 404 });
      }

      const limit = clampInt(url.searchParams.get("limit"), 10, 1, 50);

      // Digg community pages in your HAR strongly indicate TRENDING-24h behavior.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

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

      // Cloudflare edge cache (keyed by full URL including query params)
      const cacheKey = new Request(url.toString(), request);
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const endpoint = "https://apineapple-prod.digg.com/graphql";

      // We try a few likely "where" shapes because Digg's PostWhere field naming can vary.
      // If Digg changes schema, you'll get a readable 502 with errors (not Error 1101).
      const whereVariants = isAll
        ? [{ createdDate_GT: since }]
        : [
            { createdDate_GT: since, communitySlug: communitySlug },
            { createdDate_GT: since, communitySlug_EQ: communitySlug },
            { createdDate_GT: since, community: { slug: communitySlug } },
            { createdDate_GT: since, community: { slug_EQ: communitySlug } },
          ];

      let edges = null;
      let lastErr = null;

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
          edges = json.data.posts.edges;
          break;
        }

        lastErr = json?.errors || json || { status: resp.status };
      }

      if (!edges) {
        return new Response(
          "Upstream error: " + safeJson(lastErr, 2000),
          { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      }

      const items = edges.map(({ node }) => {
        const diggLink = `https://digg.com/${node.community.slug}/${node._id}/${node.slug}`;
        return {
          title: node.title || "(untitled)",
          link: node.externalContent?.url || diggLink,
          guid: diggLink,
          pubDate: node.createdDate
        };
      });

      const feedTitle = isAll
        ? "Digg — All Digg (Trending)"
        : `Digg — ${communitySlug} (Trending)`;

      const feedLink = isAll
        ? "https://digg.com/?feed=all-digg"
        : `https://digg.com/${communitySlug}`;

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
      // Prevent Cloudflare 1101 pages by returning a readable error.
      return new Response(
        "Worker error: " + (err?.stack || err?.message || String(err)),
        { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }
  }
};

function buildRss({ title, link, description, items }) {
  const now = new Date().toUTCString();
  const itemXml = (items || []).map(it => `
  <item>
    <title><![CDATA[${it.title}]]></title>
    <link>${escapeXml(it.link)}</link>
    <guid isPermaLink="true">${escapeXml(it.guid)}</guid>
    <pubDate>${new Date(it.pubDate).toUTCString()}</pubDate>
  </item>`.trim()).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title><![CDATA[${title}]]></title>
  <link>${escapeXml(link)}</link>
  <description><![CDATA[${description}]]></description>
  <lastBuildDate>${now}</lastBuildDate>
${itemXml}
</channel>
</rss>`;
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clampInt(v, fallback, min, max) {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function safeJson(obj, maxLen) {
  let s = "";
  try { s = JSON.stringify(obj); }
  catch { s = String(obj); }
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

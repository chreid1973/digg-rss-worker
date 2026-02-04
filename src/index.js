export default {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = url.pathname;

    // 👇 THIS BLOCK MUST BE CLOSED
    if (pathname.startsWith("/rss/digg/")) {
      pathname = pathname.replace("/rss/digg/", "/rss/");
    }

    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || "25", 10),
      100
    );

    // rest of your code continues…


    // Edge cache
    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // Trending window: last 48 hours
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const gqlPayload = {
      operationName: "PostsQuery",
      query: `
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
      `,
      variables: {
        first: limit,
        sort: "TOP_N",
        where: { createdDate_GT: since }
      }
    };

    const resp = await fetch("https://apineapple-prod.digg.com/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "3HPM-DiggRSS/1.0 (+https://3holepunchmedia.ca)",
        "accept": "application/json"
      },
      body: JSON.stringify(gqlPayload)
    });

    if (!resp.ok) {
      return new Response(`Digg GraphQL failed (${resp.status})`, { status: 502 });
    }

    const data = await resp.json();
    const edges = data?.data?.posts?.edges || [];

    const items = edges.map(({ node }) => {
      const diggLink = `https://digg.com/${node.community.slug}/${node._id}/${node.slug}`;
      return {
        title: node.title,
        link: node.externalContent?.url || diggLink,
        guid: diggLink,
        pubDate: node.createdDate
      };
    });

    if (!items.length) {
      return new Response("No trending posts returned.", { status: 502 });
    }

    const rss = buildRss({
      title: "Digg — All Digg (Trending)",
      link: "https://digg.com/?feed=all-digg",
      description: "Top trending posts on Digg (public, logged-out view).",
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
  }
};

function buildRss({ title, link, description, items }) {
  const now = new Date().toUTCString();
  const itemXml = items.map(it => `
  <item>
    <title><![CDATA[${it.title}]]></title>
    <link>${escapeXml(it.link)}</link>
    <guid isPermaLink="true">${escapeXml(it.guid)}</guid>
    <pubDate>${new Date(it.pubDate).toUTCString()}</pubDate>
  </item>`).join("\n");

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
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

#!/usr/bin/env python3
"""Enforce consistency across every surface that lists the field notes.

The prose on each surface is hand-authored on purpose (the homepage blurbs
are tighter cuts than the /insights ones), but the derived facts are not:
dates, ordering, and presence must agree everywhere. Source of truth is each
post's own BlogPosting JSON-LD. Checked surfaces:

  - the post itself (visible stamp matches its JSON-LD datePublished)
  - insights.html cards + its Blog JSON-LD blogPost array
  - index.html field-note cards (short-form dates -- the format that let
    the 2026-08-06 homepage drift slip past a long-form grep)
  - feed.xml items and lastBuildDate
  - sitemap.xml entries

Exit 0 when everything agrees; exit 1 with one line per mismatch otherwise.
Run from anywhere; company-site/scripts/verify.sh runs it as a check.
"""
import datetime
import json
import pathlib
import re
import sys

SITE = pathlib.Path(__file__).resolve().parent.parent / "company-site" / "site"

LD_RE = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)


def long_date(d: datetime.date) -> str:
    return f"{d:%B} {d.day}, {d.year}"


def short_date(d: datetime.date) -> str:
    return f"{d:%b} {d.day}, {d.year}"


def read_posts() -> list[dict]:
    posts = []
    for path in sorted((SITE / "insights").glob("*.html")):
        src = path.read_text()
        node = next(
            (n for m in LD_RE.finditer(src)
             for n in json.loads(m.group(1)).get("@graph", [])
             if n.get("@type") == "BlogPosting"),
            None,
        )
        if node is None:
            posts.append({"path": path, "error": "no BlogPosting JSON-LD"})
            continue
        stamp = re.search(r'<p class="stamp">(.*?)</p>', src, re.S)
        eyebrow = re.search(r'class="eyebrow">.*?</a>\s*·\s*([^<]+)</p>', src)
        posts.append({
            "path": path,
            "slug": path.stem,
            "url": node["url"],
            "headline": node["headline"],
            "date": datetime.date.fromisoformat(node["datePublished"]),
            "stamp": re.sub(r"<[^>]+>", "", stamp.group(1)).strip() if stamp else "",
            "category": eyebrow.group(1).strip() if eyebrow else "",
        })
    return posts


def cards(src: str, scope: str) -> list[tuple[str, str, str]]:
    """Return (slug, date_text, category) per card, in DOM order."""
    out = []
    for m in re.finditer(
        r'<a class="(?:post-card|card door-notes)" href="/insights/([\w-]+)">\s*'
        r'<p class="post-date">([^·<]+)·([^<]+)</p>',
        src,
    ):
        out.append((m.group(1), m.group(2).strip(), m.group(3).strip()))
    if not out:
        raise SystemExit(f"BUG: no cards matched in {scope}")
    return out


def main() -> int:
    problems = []
    posts = read_posts()
    for p in posts:
        if "error" in p:
            problems.append(f"{p['path'].name}: {p['error']}")
    posts = [p for p in posts if "error" not in p]
    newest_first = sorted(posts, key=lambda p: p["date"], reverse=True)
    by_slug = {p["slug"]: p for p in posts}

    # 1. each post's visible stamp agrees with its own JSON-LD
    for p in posts:
        want = long_date(p["date"])
        if want not in p["stamp"]:
            problems.append(
                f"{p['slug']}: stamp '{p['stamp']}' lacks datePublished '{want}'")

    # 2 + 3. the two card surfaces: presence, date text, order, category
    surfaces = [
        ("insights.html", SITE / "insights.html", long_date),
        ("index.html", SITE / "index.html", short_date),
    ]
    for name, path, fmt in surfaces:
        got = cards(path.read_text(), name)
        got_slugs = [slug for slug, _, _ in got]
        want_slugs = [p["slug"] for p in newest_first[: len(got)]]
        if set(got_slugs) != set(want_slugs):
            problems.append(f"{name}: cards {got_slugs} != posts {want_slugs}")
            continue
        if got_slugs != want_slugs:
            problems.append(
                f"{name}: card order {got_slugs} is not newest-first {want_slugs}")
        for slug, date_text, category in got:
            p = by_slug[slug]
            if date_text != fmt(p["date"]):
                problems.append(
                    f"{name}: {slug} card says '{date_text}', post says '{fmt(p['date'])}'")
            if p["category"] and category.lower() != p["category"].lower():
                problems.append(
                    f"{name}: {slug} category '{category}' != post eyebrow '{p['category']}'")

    # 2b. insights.html Blog JSON-LD blogPost array
    blog = next(
        (n for m in LD_RE.finditer((SITE / "insights.html").read_text())
         for n in json.loads(m.group(1)).get("@graph", [])
         if n.get("@type") == "Blog"),
        None,
    )
    if blog is None:
        problems.append("insights.html: no Blog JSON-LD")
    else:
        ld = {e["url"]: e["datePublished"] for e in blog["blogPost"]}
        for p in posts:
            if p["url"] not in ld:
                problems.append(f"insights.html Blog JSON-LD: missing {p['slug']}")
            elif ld[p["url"]] != p["date"].isoformat():
                problems.append(
                    f"insights.html Blog JSON-LD: {p['slug']} is {ld[p['url']]}, "
                    f"post says {p['date'].isoformat()}")

    # 4. feed.xml: same URL set, matching pubDates, honest lastBuildDate
    feed = (SITE / "feed.xml").read_text()
    items = dict(re.findall(r"<link>(\S+)</link>\s*<guid[^>]*>\S+</guid>\s*"
                            r"<pubDate>([^<]+)</pubDate>", feed))
    for p in posts:
        if p["url"] not in items:
            problems.append(f"feed.xml: missing item for {p['slug']}")
            continue
        pub = datetime.datetime.strptime(
            items[p["url"]], "%a, %d %b %Y %H:%M:%S %z").date()
        if pub != p["date"]:
            problems.append(
                f"feed.xml: {p['slug']} pubDate {pub} != datePublished {p['date']}")
    for url in items:
        if url not in {p["url"] for p in posts}:
            problems.append(f"feed.xml: item {url} has no post file")
    lbd = re.search(r"<lastBuildDate>([^<]+)</lastBuildDate>", feed)
    if lbd:
        built = datetime.datetime.strptime(
            lbd.group(1), "%a, %d %b %Y %H:%M:%S %z").date()
        if newest_first and built != newest_first[0]["date"]:
            problems.append(
                f"feed.xml: lastBuildDate {built} != newest post {newest_first[0]['date']}")
    else:
        problems.append("feed.xml: no lastBuildDate")

    # 5. sitemap.xml lists every post
    sitemap = (SITE / "sitemap.xml").read_text()
    for p in posts:
        if f"<loc>{p['url']}</loc>" not in sitemap:
            problems.append(f"sitemap.xml: missing {p['url']}")

    if problems:
        for line in problems:
            print(f"  DRIFT: {line}")
        return 1
    print(f"  field notes in sync across all surfaces ({len(posts)} posts)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

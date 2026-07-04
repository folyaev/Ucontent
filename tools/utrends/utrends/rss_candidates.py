import argparse
import json
import os
import requests
import sqlite3
import sys
import time
from urllib.parse import quote, urldefrag

import feedparser
from . import rss_parser, searxng_client
from .migrations import apply_migrations
from .text_match import matches_query


DEFAULT_DB_PATH = "trends.db"
DEFAULT_FEEDS_PATH = "feeds.json"
DEFAULT_HOURS = 504
DEFAULT_LIMIT = 5
GOOGLE_NEWS_SEARCH_URL = "https://news.google.com/rss/search"


def load_dotenv(path: str = ".env") -> None:
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as file:
        for line in file:
            raw = line.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def normalize_topic(topic: str) -> str:
    return " ".join(str(topic or "").strip().lower().replace("ё", "е").split())


def normalize_url(url: str) -> str:
    clean, _fragment = urldefrag(str(url or "").strip())
    return clean.rstrip("/")


def rejected_urls(conn: sqlite3.Connection, topic: str) -> set[str]:
    rows = conn.execute(
        "SELECT url FROM rss_candidate_rejections WHERE topic = ?",
        (normalize_topic(topic),),
    ).fetchall()
    return {normalize_url(row[0]) for row in rows}


def reject_url(db_path: str, topic: str, url: str) -> None:
    apply_migrations(db_path)
    clean_url = normalize_url(url)
    if not normalize_topic(topic) or not clean_url:
        raise ValueError("topic and url are required")
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO rss_candidate_rejections (topic, url, rejected_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            """,
            (normalize_topic(topic), clean_url),
        )
        conn.commit()


def dedupe(items: list[dict]) -> list[dict]:
    seen = set()
    seen_titles = set()
    result = []
    for item in items:
        url = normalize_url(item.get("url") or item.get("link"))
        title = str(item.get("title") or "").strip()
        title_key = " ".join(title.lower().split())
        if not url or not title or url in seen or title_key in seen_titles:
            continue
        seen.add(url)
        seen_titles.add(title_key)
        result.append({**item, "url": url, "title": title})
    return result


def rss_candidates(topic: str, archive_items: list[dict], limit: int) -> list[dict]:
    matches = []
    for item in archive_items:
        title = str(item.get("title") or "")
        if not matches_query(title, topic):
            continue
        matches.append({
            "title": title,
            "url": normalize_url(item.get("link") or item.get("url")),
            "source": str(item.get("source_name") or item.get("source") or "RSS"),
            "origin": "rss",
            "published_ts": item.get("time") or 0,
        })
    matches.sort(key=lambda item: item.get("published_ts") or 0, reverse=True)
    return dedupe(matches)[:limit]


def query_variants(query: str) -> list[str]:
    raw = str(query or "").strip()
    if not raw:
        return []
    variants = [raw]
    normalized = raw.lower().replace("ё", "е")
    has_kane = "кейн" in normalized or "kane" in normalized
    has_underwear = any(word in normalized for word in ("трус", "underwear", "pants", "boxers"))
    has_malfunction = "wardrobe" in normalized or "malfunction" in normalized
    if has_kane:
        if has_underwear or has_malfunction:
            variants.extend([
                '"Harry Kane" underwear',
                '"Harry Kane" wardrobe malfunction',
                '"Harry Kane" pants England',
                '"Harry Kane" boxers',
                "Harry Kane caught in underwear",
            ])
        variants.extend(["Гарри Кейн", '"Harry Kane"', "Harry Kane"])
    result = []
    seen = set()
    for variant in variants:
        key = variant.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(variant)
    return result[:8]


def candidate_matches_query_intent(item: dict, query: str) -> bool:
    normalized_query = query.lower().replace("ё", "е")
    text = f"{item.get('title') or ''} {item.get('url') or ''}".lower()
    if "кейн" in normalized_query or "kane" in normalized_query:
        if "кейн" not in text and "kane" not in text:
            return False
    if not any(word in normalized_query for word in ("трус", "underwear", "pants", "boxers", "wardrobe", "malfunction")):
        return True
    return any(word in text for word in ("underwear", "pants", "boxers", "wardrobe malfunction", "трус"))


def relevant_dedupe(items: list[dict], query: str) -> list[dict]:
    return [
        item
        for item in dedupe(items)
        if candidate_matches_query_intent(item, query)
    ]


def searx_candidates_for_query(query: str, hours: int, limit: int) -> list[dict]:
    if limit <= 0:
        return []
    time_range = "month" if hours > 24 else "day"
    results = searxng_client.search(
        query,
        categories="news",
        language="ru-RU",
        limit=limit,
        time_range=time_range,
        max_age_hours=hours,
    )
    return dedupe([
        {
            "title": item.get("title") or "",
            "url": item.get("url") or "",
            "source": item.get("source") or "SearXNG",
            "origin": "searxng",
            "query": query,
            "published_ts": item.get("published_ts") or 0,
        }
        for item in results
    ])[:limit]


def searx_candidates(topic: str, hours: int, limit: int) -> list[dict]:
    query = searxng_client.build_query(topic)
    return searx_candidates_for_query(query, hours, limit)


def google_news_candidates_for_query(query: str, hours: int, limit: int) -> list[dict]:
    if limit <= 0:
        return []
    try:
        url = (
            f"{GOOGLE_NEWS_SEARCH_URL}?q={quote(query)}"
            "&hl=en-US&gl=US&ceid=US:en"
        )
        feed = feedparser.parse(url)
    except Exception:
        return []

    cutoff_ts = time.time() - hours * 3600 if hours else None
    items = []
    for entry in feed.entries:
        published_ts = None
        if entry.get("published_parsed"):
            published_ts = time.mktime(entry.published_parsed)
        if cutoff_ts and published_ts and published_ts <= cutoff_ts:
            continue
        items.append({
            "title": entry.get("title") or "",
            "url": entry.get("link") or "",
            "source": "Google News",
            "origin": "google_news",
            "query": query,
            "published_ts": published_ts or 0,
        })
        if len(items) >= limit:
            break
    return dedupe(items)[:limit]


def searxng_is_available() -> bool:
    try:
        response = requests.get(
            searxng_client.SEARXNG_BASE_URL,
            timeout=min(2, searxng_client.SEARXNG_TIMEOUT_SECONDS),
            headers={"User-Agent": "UTrendsBot/1.0"},
        )
        return response.status_code < 500
    except Exception:
        return False


def build_candidates(
    topics: list[str],
    *,
    db_path: str,
    feeds_path: str,
    hours: int,
    limit: int,
    use_searxng: bool,
) -> dict:
    load_dotenv()
    apply_migrations(db_path)
    rss_parser.fetch_category_digest(feeds_path, time_window_hours=hours, archive_db_path=db_path)
    archive_items = rss_parser.load_archived_items(db_path, time_window_hours=hours)
    use_searxng = use_searxng and searxng_is_available()

    result = {}
    with sqlite3.connect(db_path) as conn:
        for topic in topics:
            clean_topic = str(topic or "").strip()
            if not clean_topic:
                continue
            rejected = rejected_urls(conn, clean_topic)
            rss_items = rss_candidates(clean_topic, archive_items, limit)
            remaining = max(0, limit - len(rss_items))
            sx_items = searx_candidates(clean_topic, hours, remaining) if use_searxng else []
            candidates = [
                item
                for item in dedupe(rss_items + sx_items)
                if normalize_url(item.get("url")) not in rejected
            ][:limit]
            result[clean_topic] = candidates
    return result


def search_candidates(
    query: str,
    *,
    db_path: str,
    feeds_path: str,
    hours: int,
    limit: int,
    use_searxng: bool,
) -> list[dict]:
    load_dotenv()
    apply_migrations(db_path)
    archive_items = rss_parser.load_archived_items(db_path, time_window_hours=hours)
    with sqlite3.connect(db_path) as conn:
        rejected = rejected_urls(conn, query)
    rss_limit = max(1, limit)
    items = rss_candidates(query, archive_items, rss_limit)
    variants = query_variants(query)
    if use_searxng and searxng_is_available():
        for variant in variants:
            remaining = max(0, limit - len(relevant_dedupe(items, query)))
            if remaining <= 0:
                break
            items.extend(searx_candidates_for_query(variant, hours, remaining))
    for variant in variants:
        remaining = max(0, limit - len(relevant_dedupe(items, query)))
        if remaining <= 0:
            break
        items.extend(google_news_candidates_for_query(variant, hours, remaining))
    return [
        item
        for item in relevant_dedupe(items, query)
        if normalize_url(item.get("url")) not in rejected
    ][:limit]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Find RSS/SearXNG candidates for existing UContent topics.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    candidates = subparsers.add_parser("candidates")
    candidates.add_argument("--topics-json", required=True)
    candidates.add_argument("--db", default=DEFAULT_DB_PATH)
    candidates.add_argument("--feeds", default=DEFAULT_FEEDS_PATH)
    candidates.add_argument("--hours", type=int, default=DEFAULT_HOURS)
    candidates.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    candidates.add_argument("--no-searxng", dest="use_searxng", action="store_false")
    candidates.set_defaults(use_searxng=True)

    reject = subparsers.add_parser("reject")
    reject.add_argument("--topic", required=True)
    reject.add_argument("--url", required=True)
    reject.add_argument("--db", default=DEFAULT_DB_PATH)

    search = subparsers.add_parser("search")
    search.add_argument("--query", required=True)
    search.add_argument("--db", default=DEFAULT_DB_PATH)
    search.add_argument("--feeds", default=DEFAULT_FEEDS_PATH)
    search.add_argument("--hours", type=int, default=DEFAULT_HOURS)
    search.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    search.add_argument("--no-searxng", dest="use_searxng", action="store_false")
    search.set_defaults(use_searxng=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    args = parse_args(argv or sys.argv[1:])

    if args.command == "reject":
        reject_url(args.db, args.topic, args.url)
        print(json.dumps({"ok": True}, ensure_ascii=False))
        return 0

    if args.command == "search":
        payload = search_candidates(
            args.query,
            db_path=args.db,
            feeds_path=args.feeds,
            hours=args.hours,
            limit=args.limit,
            use_searxng=args.use_searxng,
        )
        print(json.dumps({"query": args.query, "items": payload}, ensure_ascii=False))
        return 0

    topics = json.loads(args.topics_json)
    if not isinstance(topics, list):
        raise ValueError("--topics-json must be a JSON array")
    payload = build_candidates(
        [str(topic) for topic in topics],
        db_path=args.db,
        feeds_path=args.feeds,
        hours=args.hours,
        limit=args.limit,
        use_searxng=args.use_searxng,
    )
    print(json.dumps({"topics": payload}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

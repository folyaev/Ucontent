import argparse
import datetime as dt
import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from . import rss_parser
from .migrations import apply_migrations
from .text_match import matches_query


DEFAULT_HOURS = 504
DEFAULT_UCONTENT_URL = "http://127.0.0.1:5197"
DEFAULT_DB_PATH = "trends.db"
MAX_LINKS_PER_TOPIC = 4
SKIP_TOPIC_NAMES = {"интро", "intro", "outro", "аутро", "конец", "финал"}


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


def _today_id(now: dt.datetime) -> str:
    return now.strftime("utrends-%Y-%m-%d")


def _title(now: dt.datetime, hours: int) -> str:
    return f"UTrends {now:%Y-%m-%d} / {hours}h"


def _clean(value: object) -> str:
    return str(value or "").strip()


def build_markdown(digest: dict, *, title: str, hours: int) -> str:
    lines: list[str] = [
        f"# {title}",
        "",
        f"RSS-дайджест за последние {hours} часов.",
        "",
        "К новостям!",
        "",
    ]

    for category, topics in digest.items():
        for topic in topics:
            topic_title = _clean(topic.get("main_title")) or "Без названия"
            lines.extend([
                f"### {category} / {topic_title}",
                "",
            ])

            items = topic.get("items") or []
            for item in items[:6]:
                source = _clean(item.get("source_name")) or _clean(item.get("source")) or "Источник"
                item_title = _clean(item.get("title")) or topic_title
                link = _clean(item.get("link")) or _clean(item.get("url"))

                lines.extend([
                    f"{source}: {item_title}",
                    "",
                ])
                if link:
                    lines.extend([link, ""])

            if not items:
                lines.extend(["Empty topic. Add segment", ""])

    return "\n".join(lines).rstrip() + "\n"


def post_to_ucontent(base_url: str, payload: dict) -> dict:
    endpoint = base_url.rstrip("/") + "/api/import-markdown"
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        endpoint,
        data=body,
        headers={"content-type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def request_json(url: str, *, method: str = "GET", payload: dict | None = None) -> dict:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json; charset=utf-8"
    request = Request(url, data=data, headers=headers, method=method)
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def get_latest_scrape(base_url: str) -> dict:
    return request_json(base_url.rstrip("/") + "/api/latest").get("scrape") or {}


def put_scrape_content(base_url: str, scrape_id: str, content: str) -> dict:
    endpoint = base_url.rstrip("/") + f"/api/scrapes/{scrape_id}"
    return request_json(endpoint, method="PUT", payload={"content": content})


def parse_sections(content: str) -> list[dict]:
    lines = StringLines(content)
    sections = []
    for index, line in enumerate(lines.items):
        match = re.match(r"^###\s+(.+?)\s*$", line)
        if not match:
            continue
        title = match.group(1).strip()
        end = len(lines.items)
        for next_index in range(index + 1, len(lines.items)):
            if re.match(r"^###\s+(.+?)\s*$", lines.items[next_index]):
                end = next_index
                break
        sections.append({"title": title, "start": index, "end": end})
    return sections


class StringLines:
    def __init__(self, content: str):
        self.items = StringLines.split(content)

    @staticmethod
    def split(content: str) -> list[str]:
        return StringLines._strip_trailing_empty(String(content).replace("\r\n", "\n").replace("\r", "\n").split("\n"))

    @staticmethod
    def _strip_trailing_empty(lines: list[str]) -> list[str]:
        while lines and lines[-1] == "":
            lines.pop()
        return lines


def String(value: object) -> str:
    return str(value or "")


def normalize_topic(topic: str) -> str:
    return re.sub(r"\s+", " ", topic.strip().lower().replace("ё", "е"))


def should_skip_topic(topic: str) -> bool:
    normalized = normalize_topic(topic)
    return not normalized or normalized in SKIP_TOPIC_NAMES


def existing_urls(lines: list[str]) -> set[str]:
    urls = set()
    for line in lines:
        value = line.strip()
        if value.startswith("http://") or value.startswith("https://"):
            urls.add(value)
    return urls


def candidate_key(item: dict) -> str:
    return String(item.get("url") or item.get("link")).split("#", 1)[0].rstrip("/")


def rss_matches_for_topic(topic: str, archive_items: list[dict], limit: int) -> list[dict]:
    matches = []
    for item in archive_items:
        title = String(item.get("title"))
        if not matches_query(title, topic):
            continue
        matches.append({
            "title": title,
            "url": String(item.get("link") or item.get("url")),
            "source": String(item.get("source_name") or item.get("source") or "RSS"),
            "published_ts": item.get("time") or 0,
        })
    matches.sort(key=lambda item: item.get("published_ts") or 0, reverse=True)
    return dedupe_candidates(matches)[:limit]


def searx_matches_for_topic(topic: str, hours: int, limit: int) -> list[dict]:
    from . import searxng_client

    time_range = "month" if hours > 24 else "day"
    query = searxng_client.build_query(topic)
    results = searxng_client.search(
        query,
        categories="news",
        language="ru-RU",
        limit=limit,
        time_range=time_range,
        max_age_hours=hours,
    )
    return [
        {
            "title": String(item.get("title")),
            "url": String(item.get("url")),
            "source": String(item.get("source") or "SearXNG"),
            "published_ts": item.get("published_ts") or 0,
        }
        for item in results
        if String(item.get("url")) and String(item.get("title"))
    ]


def dedupe_candidates(items: list[dict]) -> list[dict]:
    seen = set()
    result = []
    for item in items:
        key = candidate_key(item)
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def format_topic_links(items: list[dict]) -> list[str]:
    lines = []
    for item in items:
        source = String(item.get("source")) or "Источник"
        title = String(item.get("title"))
        url = String(item.get("url"))
        lines.extend([f"{source}: {title}", "", url, ""])
    return lines


def enrich_content_with_topic_links(content: str, topic_links: dict[str, list[dict]]) -> str:
    lines = StringLines.split(content)
    sections = parse_sections(content)
    known_urls = existing_urls(lines)

    for section in reversed(sections):
        topic = section["title"]
        links = [
            item
            for item in topic_links.get(topic, [])
            if candidate_key(item) not in known_urls
        ]
        if not links:
            continue
        insert_at = section["start"] + 1
        insert_lines = [""] + format_topic_links(links)
        lines[insert_at:insert_at] = insert_lines
        known_urls.update(candidate_key(item) for item in links)

    return "\n".join(lines).rstrip() + "\n"


def enrich_latest_ucontent(args: argparse.Namespace) -> int:
    load_dotenv()
    apply_migrations(args.db)
    rss_parser.fetch_category_digest(args.feeds, time_window_hours=args.hours, archive_db_path=args.db)
    archive_items = rss_parser.load_archived_items(args.db, time_window_hours=args.hours)

    scrape = get_latest_scrape(args.ucontent_url)
    scrape_id = String(scrape.get("id"))
    content = String(scrape.get("content"))
    if not scrape_id or not content.strip():
        print("UContent latest scrape is empty", file=sys.stderr)
        return 1

    sections = [section for section in parse_sections(content) if not should_skip_topic(section["title"])]
    topic_links = {}
    for section in sections:
        topic = section["title"]
        rss_items = rss_matches_for_topic(topic, archive_items, args.links_per_topic)
        remaining = max(0, args.links_per_topic - len(rss_items))
        searx_items = searx_matches_for_topic(topic, args.hours, remaining) if remaining and args.use_searxng else []
        topic_links[topic] = dedupe_candidates(rss_items + searx_items)[:args.links_per_topic]

    enriched = enrich_content_with_topic_links(content, topic_links)
    added = len(existing_urls(StringLines.split(enriched)) - existing_urls(StringLines.split(content)))
    if args.dry_run:
        print(enriched)
        print(f"\nAdded URLs: {added}", file=sys.stderr)
        return 0

    put_scrape_content(args.ucontent_url, scrape_id, enriched)
    matched_topics = sum(1 for items in topic_links.values() if items)
    print(f"Enriched {scrape_id}: added {added} URLs across {matched_topics} topics")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export UTrends RSS digest to UContent.")
    parser.add_argument("--hours", type=int, default=DEFAULT_HOURS, help=f"RSS window in hours. Default: {DEFAULT_HOURS}.")
    parser.add_argument("--id", default="", help="UContent scrape id. Default: utrends-YYYY-MM-DD.")
    parser.add_argument("--title", default="", help="UContent title. Default: UTrends YYYY-MM-DD / <hours>h.")
    parser.add_argument("--feeds", default="feeds.json", help="Path to feeds.json.")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help=f"Path to trends.db. Default: {DEFAULT_DB_PATH}.")
    parser.add_argument("--ucontent-url", default=DEFAULT_UCONTENT_URL, help=f"UContent base URL. Default: {DEFAULT_UCONTENT_URL}.")
    parser.add_argument("--enrich-latest", action="store_true", help="Add matching RSS/SearXNG links to topics in the current UContent document.")
    parser.add_argument("--links-per-topic", type=int, default=MAX_LINKS_PER_TOPIC, help=f"Max links to add per existing topic. Default: {MAX_LINKS_PER_TOPIC}.")
    parser.add_argument("--no-searxng", dest="use_searxng", action="store_false", help="Use only the local RSS archive.")
    parser.set_defaults(use_searxng=True)
    parser.add_argument("--dry-run", action="store_true", help="Print markdown instead of posting to UContent.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    args = parse_args(argv or sys.argv[1:])
    if args.hours <= 0:
        print("--hours must be positive", file=sys.stderr)
        return 2
    if args.links_per_topic <= 0:
        print("--links-per-topic must be positive", file=sys.stderr)
        return 2
    if args.enrich_latest:
        return enrich_latest_ucontent(args)

    now = dt.datetime.now()
    scrape_id = args.id.strip() or _today_id(now)
    title = args.title.strip() or _title(now, args.hours)

    apply_migrations(args.db)
    rss_parser.fetch_category_digest(args.feeds, time_window_hours=args.hours, archive_db_path=args.db)
    archived_items = rss_parser.load_archived_items(args.db, time_window_hours=args.hours)
    digest = rss_parser.build_category_digest_from_items(archived_items)
    content = build_markdown(digest, title=title, hours=args.hours)

    if args.dry_run:
        print(content)
        return 0

    payload = {
        "id": scrape_id,
        "title": title,
        "url": f"utrends://rss-digest?hours={args.hours}",
        "content": content,
    }
    try:
        response = post_to_ucontent(args.ucontent_url, payload)
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        print(f"UContent import failed: HTTP {exc.code}: {details}", file=sys.stderr)
        return 1
    except (URLError, TimeoutError) as exc:
        print(f"UContent is not reachable at {args.ucontent_url}: {exc}", file=sys.stderr)
        return 1

    scrape = response.get("scrape", {})
    print(f"Imported {scrape.get('id', scrape_id)}: {len(scrape.get('segments') or [])} segments")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

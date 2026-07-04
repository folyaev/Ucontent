import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, wait

import feedparser
import requests

from .config import env_int
from .text_match import title_signature, token_set, titles_similar


TIMECODE_RE = re.compile(r"(?<!\d)(?:\d{1,2}:)?\d{1,2}:\d{2}(?!\d)")
CHAPTER_RE = re.compile(r"(?m)(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—:]?\s*(.+)")
HTML_TAG_RE = re.compile(r"<[^>]+>")
BLOGGER_MAX_WORKERS = env_int("BLOGGER_MAX_WORKERS", 12, minimum=1)
BLOGGER_DIGEST_TIMEOUT_SECONDS = env_int("BLOGGER_DIGEST_TIMEOUT_SECONDS", 30, minimum=1)
BLOGGER_FETCH_TIMEOUT_SECONDS = env_int("BLOGGER_FETCH_TIMEOUT_SECONDS", 5, minimum=1)
BLOGGER_INCLUDE_SHORTS = env_int("BLOGGER_INCLUDE_SHORTS", 0, minimum=0)
DEFAULT_HEADERS = {'User-Agent': 'UTrendsBot/1.0 (Telegram news aggregator)'}
TITLE_CLEANUP_SUFFIXES = (
    " | Breaking Points",
    " | BBC News",
    " - BBC News",
    " | DW News",
    " | DW",
    " | Reuters",
    " | AP",
    " | CNN",
    " | ABC News",
    ": Last Week Tonight with John Oliver",
    ": Last Week Tonight with John Oliver (HBO)",
)
TITLE_SPLITTERS = (" / ", " | ", " // ", " — ", " - ", "? ", ": ")
TOPIC_NOISE_EXACT = {
    "live",
    "watch live",
    "breaking news",
    "latest news",
    "news live",
}
CHAPTER_NOISE = (
    "подписывайтесь",
    "реклама",
    "донат",
    "мерч",
    "boosty",
    "patreon",
    "сотрудничество",
    "поддержать",
)


def is_noise_topic(topic: str) -> bool:
    normalized = re.sub(r"[^a-zA-Z0-9]+", " ", topic or "").strip().lower()
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized in TOPIC_NOISE_EXACT


def load_bloggers(file_path: str = "bloggers.json") -> list[dict]:
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        channels = data.get("channels", [])
    else:
        channels = data
    return [
        {
            "name": str(channel.get("name") or "").strip(),
            "url": str(channel.get("url") or "").strip(),
            "source_id": str(channel.get("source_id") or "").strip(),
            "platform": str(channel.get("platform") or "youtube").strip(),
            "language": str(channel.get("language") or "").strip(),
            "region_focus": str(channel.get("region_focus") or "").strip(),
            "parser_priority": int(channel.get("parser_priority") or 2),
            "banned_ru": bool(channel.get("banned_ru", False)),
        }
        for channel in channels
        if isinstance(channel, dict) and channel.get("url")
    ]


def extract_timecodes(text: str, limit: int = 12) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for match in TIMECODE_RE.findall(text or ""):
        if match in seen:
            continue
        seen.add(match)
        result.append(match)
        if len(result) >= limit:
            break
    return result


def description_snippet(text: str, limit: int = 180) -> str:
    cleaned = HTML_TAG_RE.sub(" ", text or "")
    cleaned = TIMECODE_RE.sub(" ", cleaned)
    cleaned = re.sub(r"https?://\S+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "…"


def timecode_to_seconds(value: str) -> int:
    parts = [int(part) for part in value.split(":")]
    if len(parts) == 2:
        minutes, seconds = parts
        return minutes * 60 + seconds
    if len(parts) == 3:
        hours, minutes, seconds = parts
        return hours * 3600 + minutes * 60 + seconds
    raise ValueError(f"Bad timecode: {value}")


def parse_chapters(description: str) -> list[dict]:
    chapters = []
    for match in CHAPTER_RE.finditer(description or ""):
        start_time = match.group(1).strip()
        title = HTML_TAG_RE.sub(" ", match.group(2)).strip()
        title = re.sub(r"\s+", " ", title)
        if not title:
            continue
        title_lower = title.lower()
        if any(noise in title_lower for noise in CHAPTER_NOISE):
            continue
        try:
            start_seconds = timecode_to_seconds(start_time)
        except ValueError:
            continue
        chapters.append({
            "start_time": start_time,
            "start_seconds": start_seconds,
            "title": title,
        })

    if len(chapters) < 3:
        return []
    seconds = [chapter["start_seconds"] for chapter in chapters]
    if seconds != sorted(seconds) or seconds[0] > 15:
        return []
    return chapters


def split_title_topics(title: str) -> list[str]:
    clean_title = (title or "").strip()
    if not clean_title:
        return []
    for suffix in TITLE_CLEANUP_SUFFIXES:
        if suffix in clean_title:
            clean_title = clean_title.split(suffix, 1)[0].strip()
    for splitter in TITLE_SPLITTERS:
        if splitter in clean_title:
            parts = [
                part.strip()
                for part in clean_title.split(splitter)
                if len(part.strip()) > 2 and not is_noise_topic(part)
            ]
            if len(parts) > 1:
                return parts[:4]
            if parts:
                return parts[:1]
    if is_noise_topic(clean_title):
        return []
    return [clean_title]


def _entry_description(entry) -> str:
    return (
        entry.get("summary")
        or entry.get("description")
        or entry.get("media_description")
        or ""
    )


def timestamped_url(url: str, seconds: int | None) -> str:
    if seconds is None:
        return url
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}t={seconds}s"


def canonical_video_url(url: str) -> str:
    return (url or "").split("?", 1)[0].split("#", 1)[0].rstrip("/")


def is_short_video(url: str, title: str = "") -> bool:
    raw = f"{url or ''} {title or ''}".lower()
    return "/shorts/" in raw or "#shorts" in raw


def fetch_blogger_channel(channel: dict, limit: int = 15) -> list[dict]:
    url = channel["url"]
    channel_name = channel.get("name") or ""
    try:
        response = requests.get(url, headers=DEFAULT_HEADERS, timeout=BLOGGER_FETCH_TIMEOUT_SECONDS)
        response.raise_for_status()
        feed = feedparser.parse(response.content)
        feed_title = feed.feed.get("title") or channel_name
        videos = []
        for entry in feed.entries[:limit]:
            published_ts = time.time()
            if entry.get("published_parsed"):
                published_ts = time.mktime(entry.published_parsed)
            description = _entry_description(entry)
            title = entry.get("title", "")
            link = entry.get("link", "")
            if not BLOGGER_INCLUDE_SHORTS and is_short_video(link, title):
                continue
            title_topics = split_title_topics(title)
            chapters = parse_chapters(description)
            videos.append({
                "title": title,
                "link": link,
                "video_url": canonical_video_url(link),
                "is_short": is_short_video(link, title),
                "channel": channel_name or feed_title,
                "feed_title": feed_title,
                "source_id": channel.get("source_id", ""),
                "language": channel.get("language", ""),
                "region_focus": channel.get("region_focus", ""),
                "parser_priority": channel.get("parser_priority", 2),
                "description": description,
                "description_snippet": description_snippet(description),
                "timecodes": extract_timecodes(description),
                "chapters": chapters[:8],
                "title_topics": title_topics,
                "time": published_ts,
                "words": token_set(" ".join(title_topics) if title_topics else title),
            })
        return videos
    except Exception as e:
        logging.warning(f"Blogger feed parsing error for {url}: {e}")
        return []


def _topic_mentions(videos: list[dict]) -> list[dict]:
    mentions: list[dict] = []
    order = 0
    for video in videos:
        link = video.get("link", "")
        video_url = video.get("video_url") or canonical_video_url(link)
        for topic in video.get("title_topics") or [video.get("title", "")]:
            topic = (topic or "").strip()
            if len(topic) < 3 or is_noise_topic(topic):
                continue
            mentions.append({
                "topic": topic,
                "title": video.get("title", ""),
                "video_title": video.get("title", ""),
                "link": link,
                "video_url": video_url,
                "channel": video.get("channel", ""),
                "time": video.get("time") or 0,
                "order": order,
                "source": "title",
                "start_time": "",
                "start_seconds": None,
                "words": token_set(topic),
            })
            order += 1

        for chapter in video.get("chapters") or []:
            topic = (chapter.get("title") or "").strip()
            if len(topic) < 3:
                continue
            start_seconds = chapter.get("start_seconds")
            mentions.append({
                "topic": topic,
                "title": topic,
                "video_title": video.get("title", ""),
                "link": timestamped_url(link, start_seconds),
                "video_url": video_url,
                "channel": video.get("channel", ""),
                "time": video.get("time") or 0,
                "order": order,
                "source": "chapter",
                "start_time": chapter.get("start_time", ""),
                "start_seconds": start_seconds,
                "words": token_set(topic),
            })
            order += 1
    return mentions


def _cluster_topic_mentions(videos: list[dict]) -> list[dict]:
    clusters: list[dict] = []
    for mention in _topic_mentions(videos):
        matched = False
        for cluster in clusters:
            overlap = mention["words"] & cluster["words"]
            if (
                len(overlap) >= 3
                or titles_similar(mention["topic"], cluster["main_title"], threshold=0.58)
            ):
                cluster["items"].append(mention)
                cluster["words"].update(mention["words"])
                cluster["first_order"] = min(cluster["first_order"], mention["order"])
                matched = True
                break
        if not matched:
            clusters.append({
                "main_title": mention["topic"],
                "words": set(mention["words"]),
                "items": [mention],
                "first_order": mention["order"],
            })

    for cluster in clusters:
        channels = {item["channel"] for item in cluster["items"] if item.get("channel")}
        urls = {item["video_url"] for item in cluster["items"] if item.get("video_url")}
        cluster["channel_count"] = len(channels)
        cluster["item_count"] = len(cluster["items"])
        cluster["video_count"] = len(urls)
        cluster["is_repeated"] = cluster["channel_count"] > 1 or cluster["video_count"] > 1

    clusters.sort(key=lambda item: (
        0 if item["is_repeated"] else 1,
        -item["channel_count"],
        -item["item_count"],
        item["first_order"],
    ))
    return clusters


def _cluster_videos(videos: list[dict]) -> list[dict]:
    clusters: list[dict] = []
    for video in videos:
        matched = False
        for cluster in clusters:
            overlap = video["words"] & cluster["words"]
            if (
                len(overlap) >= 3
                or titles_similar(video["title"], cluster["main_title"], threshold=0.55)
            ):
                cluster["items"].append(video)
                cluster["words"].update(video["words"])
                matched = True
                break
        if not matched:
            clusters.append({
                "main_title": video["title"],
                "words": set(video["words"]),
                "items": [video],
            })
    return clusters


def build_blogger_digest(file_path: str = "bloggers.json", time_window_hours: int = 24) -> dict:
    cutoff = time.time() - time_window_hours * 3600
    videos: list[dict] = []
    channels = load_bloggers(file_path)
    executor = ThreadPoolExecutor(max_workers=min(BLOGGER_MAX_WORKERS, max(1, len(channels))))
    try:
        futures = [executor.submit(fetch_blogger_channel, channel) for channel in channels]
        done, pending = wait(futures, timeout=BLOGGER_DIGEST_TIMEOUT_SECONDS)
        for future in pending:
            future.cancel()
        for future in done:
            try:
                videos.extend(future.result())
            except Exception as e:
                logging.warning(f"Blogger digest source failed: {e}")
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    fresh = [video for video in videos if video["time"] > cutoff]
    fresh.sort(key=lambda item: item["time"], reverse=True)

    clusters = _cluster_videos(fresh)
    repeated = []
    for cluster in clusters:
        channels = {item["channel"] for item in cluster["items"]}
        if len(channels) < 2:
            continue
        cluster["channel_count"] = len(channels)
        cluster["item_count"] = len(cluster["items"])
        repeated.append(cluster)
    repeated.sort(key=lambda item: (item["channel_count"], item["item_count"]), reverse=True)

    topic_clusters = _cluster_topic_mentions(fresh)
    repeated_topics = [cluster for cluster in topic_clusters if cluster["is_repeated"]]
    single_topics = [cluster for cluster in topic_clusters if not cluster["is_repeated"]]

    seen_titles: set[str] = set()
    latest = []
    for video in fresh:
        signature = title_signature(video["title"])
        if signature in seen_titles:
            continue
        seen_titles.add(signature)
        latest.append(video)
        if len(latest) >= 10:
            break

    return {
        "videos": fresh,
        "repeated": repeated[:5],
        "topic_clusters": topic_clusters,
        "repeated_topics": repeated_topics,
        "single_topics": single_topics,
        "latest": latest,
    }

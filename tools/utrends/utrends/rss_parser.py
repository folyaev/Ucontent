import json
import feedparser
import logging
import re
import datetime
import time
import requests
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from bs4 import BeautifulSoup
from collections import defaultdict
from .config import env_int
from requests.adapters import HTTPAdapter
from .social_feeds import build_rsshub_social_feeds
from .text_match import matches_query, title_signature, token_set, titles_similar
from urllib3.util import Retry

FETCH_TIMEOUT_SECONDS = env_int("RSS_FETCH_TIMEOUT_SECONDS", 5)
SEARCH_MAX_WORKERS = env_int("RSS_SEARCH_MAX_WORKERS", 24)
FETCH_RETRIES = env_int("RSS_FETCH_RETRIES", 2, minimum=0)
FETCH_BACKOFF_SECONDS = env_int("RSS_FETCH_BACKOFF_SECONDS", 1, minimum=0)
DEFAULT_HEADERS = {'User-Agent': 'UTrendsBot/1.0 (Telegram news aggregator)'}
SOCIAL_CATEGORY = "Соцсети"

_HTTP_SESSION = None


def get_http_session() -> requests.Session:
    """Return a process-wide requests session with retry for transient RSS errors."""
    global _HTTP_SESSION
    if _HTTP_SESSION is None:
        session = requests.Session()
        retry = Retry(
            total=FETCH_RETRIES,
            connect=FETCH_RETRIES,
            read=FETCH_RETRIES,
            status=FETCH_RETRIES,
            backoff_factor=FETCH_BACKOFF_SECONDS,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=("GET", "HEAD"),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry)
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        _HTTP_SESSION = session
    return _HTTP_SESSION


def fetch_url(url: str, headers=None) -> requests.Response:
    response = get_http_session().get(
        url,
        headers=headers or DEFAULT_HEADERS,
        timeout=FETCH_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return response

def normalize_text(text):
    return token_set(text)

def parse_date(date_str):
    try:
        return time.mktime(date_str)
    except:
        return time.time()

def clean_source_name(feed_title: str, domain_fallback: str) -> str:
    """Возвращает короткое название источника.
    Если feed title слишком длинный или выглядит как описание — используем домен.
    """
    if not feed_title:
        return domain_fallback
    # Если название длиннее 30 символов или содержит 'все' + 'новости'/'посты' — подозрительно
    lower = feed_title.lower()
    if len(feed_title) > 30 or ('все' in lower and ('новост' in lower or 'пост' in lower or 'подряд' in lower)):
        return domain_fallback
    return feed_title


def fetch_source(url):
    items = []
    # Базовое имя по домену
    domain = url.split('/')[2].replace('www.', '') if 'youtube' not in url else 'YouTube'
    source_name = domain
    
    if "forbes.ru" in url:
        try:
            html = fetch_url(
                url,
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'},
            ).text
            soup = BeautifulSoup(html, 'html.parser')
            source_name = "Forbes"
            seen_links = set()
            seen_titles = set()
            for a in soup.find_all('a', href=True):
                text = a.text.strip()
                href = a['href']
                # Только статьи (содержат /articles/ или /profile/ и т.п.)
                if not (href.startswith('/') or 'forbes.ru' in href):
                    continue
                full_link = f"https://www.forbes.ru{href}" if href.startswith('/') else href
                # Убираем query-параметры для дедупликации
                clean_link = full_link.split('?')[0].rstrip('/')
                title_norm = text.lower()
                if len(text) < 30:
                    continue
                if clean_link in seen_links or title_norm in seen_titles:
                    continue
                seen_links.add(clean_link)
                seen_titles.add(title_norm)
                items.append({
                    'title': text,
                    'link': full_link,
                    'time': time.time(),
                    'source_name': source_name
                })
        except Exception as e:
            logging.warning(f"Forbes parsing error: {e}")
    else:
        try:
            # Reddit требует кастомный User-Agent иначе блокирует
            resp = fetch_url(url)
            feed = feedparser.parse(resp.content)
            raw_title = feed.feed.get('title', '')
            source_name = clean_source_name(raw_title, domain)

            for entry in feed.entries[:30]:
                is_youtube = 'youtube.com' in url
                pub_time = time.time()
                if entry.get('published_parsed'):
                    pub_time = time.mktime(entry.published_parsed)

                # YouTube: извлекаем просмотры из media:statistics
                views = ''
                if is_youtube:
                    stats = entry.get('media_statistics', {})
                    if isinstance(stats, dict):
                        raw_v = stats.get('views', '')
                        if raw_v:
                            try:
                                views = f"{int(raw_v):,}".replace(',', '\u00a0')
                            except ValueError:
                                views = raw_v

                items.append({
                    'title':       entry.get('title', ''),
                    'link':        entry.get('link', ''),
                    'time':        pub_time,
                    'source_name': source_name,
                    'views':       views,
                })
        except Exception as e:
            logging.warning(f"Feed parsing error for {url}: {e}")
            
    # keep unique normalized titles and top latest 30 max to avoid spam
    unique_items = []
    seen = set()
    for item in items:
        signature = title_signature(item['title'])
        if signature and signature not in seen:
            seen.add(signature)
            unique_items.append(item)
    return unique_items[:30]

def load_categories(file_path="feeds.json"):
    with open(file_path, "r", encoding="utf-8") as f:
        categories = json.load(f)
    social_feeds = build_rsshub_social_feeds()
    if social_feeds:
        categories = dict(categories)
        categories.setdefault(SOCIAL_CATEGORY, [])
        for url in social_feeds:
            if url not in categories[SOCIAL_CATEGORY]:
                categories[SOCIAL_CATEGORY].append(url)
    return categories


def archive_items(db_path: str, items: list[dict]) -> None:
    if not db_path or not items:
        return
    rows = []
    for item in items:
        url = (item.get("link") or item.get("url") or "").strip()
        title = (item.get("title") or "").strip()
        if not url or not title:
            continue
        rows.append((
            url,
            title,
            item.get("source_name") or item.get("source") or "",
            item.get("source_url") or "",
            item.get("category") or "",
            float(item.get("time") or time.time()),
        ))
    if not rows:
        return
    with sqlite3.connect(db_path) as conn:
        conn.executemany(
            """
            INSERT INTO rss_items (url, title, source_name, source_url, category, published_ts)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
                title = excluded.title,
                source_name = excluded.source_name,
                source_url = excluded.source_url,
                category = excluded.category,
                published_ts = excluded.published_ts,
                last_seen_at = CURRENT_TIMESTAMP
            """,
            rows,
        )
        conn.commit()


def load_archived_items(db_path: str, time_window_hours: int, allowed_categories=None) -> list[dict]:
    cutoff_time = time.time() - (time_window_hours * 3600)
    allowed_categories = set(allowed_categories) if allowed_categories is not None else None
    query = """
        SELECT title, url, source_name, source_url, category, published_ts
        FROM rss_items
        WHERE published_ts > ?
        ORDER BY published_ts DESC
    """
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(query, (cutoff_time,)).fetchall()
    items = []
    for title, url, source_name, source_url, category, published_ts in rows:
        if allowed_categories is not None and category not in allowed_categories:
            continue
        items.append({
            "title": title,
            "link": url,
            "time": published_ts or 0,
            "source_name": source_name or "",
            "source_url": source_url or "",
            "category": category or "",
            "words": normalize_text(title),
        })
    return items


def build_category_digest_from_items(items: list[dict]) -> dict:
    digest = {}

    grouped_items = defaultdict(list)
    for item in items:
        grouped_items[item.get("category") or "RSS"].append(item)

    for cat_name, all_items in grouped_items.items():

        # Clustering
        clusters = []
        for item in all_items:
            matched = False
            for cluster in clusters:
                # Check overlap
                overlap = item['words'].intersection(cluster['words'])
                # If they share at least 3 significant words, they are likely the same topic
                # Or if one title is very short and shares 2 words
                if (
                    len(overlap) >= 3
                    or (len(item['words']) > 0 and len(overlap) / len(item['words']) > 0.5)
                    or titles_similar(item['title'], cluster['main_title'])
                ):
                    # Only add if it's from a different source
                    sources_in_cluster = {x['source_url'] for x in cluster['items']}
                    if item['source_url'] not in sources_in_cluster:
                        cluster['items'].append(item)
                        cluster['words'].update(item['words']) # expand cluster vocabulary
                    matched = True
                    break
            
            if not matched:
                clusters.append({
                    'words': set(item['words']),
                    'items': [item],
                    'main_title': item['title']
                })
        
        # Кластеры из ≥2 источников — настоящий тренд
        valid_clusters = [c for c in clusters if len(c['items']) >= 2]
        valid_clusters.sort(key=lambda x: len(x['items']), reverse=True)

        if valid_clusters:
            digest[cat_name] = valid_clusters[:5]
        elif all_items:
            # Фоллбэк: нет пересечений — показываем топ-5 свежих одиночных новостей
            all_items.sort(key=lambda x: x['time'], reverse=True)
            seen_titles = set()
            singles = []
            for item in all_items:
                signature = title_signature(item['title'])
                if signature and signature not in seen_titles:
                    seen_titles.add(signature)
                    singles.append({
                        'main_title': item['title'],
                        'items': [item]
                    })
                if len(singles) >= 5:
                    break
            if singles:
                digest[cat_name] = singles

    return digest


def fetch_category_digest(file_path="feeds.json", time_window_hours=12, archive_db_path: str | None = None):
    categories = load_categories(file_path)

    cutoff_time = time.time() - (time_window_hours * 3600)
    all_digest_items = []

    for cat_name, urls in categories.items():
        for url in urls:
            items = fetch_source(url)
            archive_batch = []
            for item in items:
                item['words'] = normalize_text(item['title'])
                item['source_url'] = url
                item['category'] = cat_name
                archive_batch.append(item)
                if item['time'] > cutoff_time:
                    all_digest_items.append(item)
            archive_items(archive_db_path, archive_batch)

    return build_category_digest_from_items(all_digest_items)

def search_feeds(query, file_path="feeds.json", time_window_hours=48, allowed_categories=None):
    categories = load_categories(file_path)

    cutoff_time = time.time() - (time_window_hours * 3600)
    results = []
    
    allowed_categories = set(allowed_categories) if allowed_categories is not None else None

    feed_sources = [
        (cat_name, url)
        for cat_name, urls in categories.items()
        if allowed_categories is None or cat_name in allowed_categories
        for url in urls
    ]

    with ThreadPoolExecutor(max_workers=SEARCH_MAX_WORKERS) as executor:
        future_to_source = {
            executor.submit(fetch_source, url): (cat_name, url)
            for cat_name, url in feed_sources
        }
        for future in as_completed(future_to_source):
            cat_name, url = future_to_source[future]
            try:
                items = future.result()
            except Exception as e:
                logging.warning(f"Feed search error for {url}: {e}")
                continue
            for item in items:
                if item['time'] > cutoff_time:
                    if matches_query(item['title'], query):
                        item['category'] = cat_name
                        item['source'] = item['source_name']
                        results.append(item)
                
    # Sort by time newest first
    results.sort(key=lambda x: x['time'], reverse=True)
    return results

def fetch_all_items(file_path="feeds.json", time_window_hours=3, allowed_categories=None):
    categories = load_categories(file_path)

    cutoff_time = time.time() - (time_window_hours * 3600)
    allowed_categories = set(allowed_categories) if allowed_categories is not None else None
    all_items = []

    for cat_name, urls in categories.items():
        if allowed_categories is not None and cat_name not in allowed_categories:
            continue
        for url in urls:
            items = fetch_source(url)
            for item in items:
                if item['time'] > cutoff_time:
                    item['category'] = cat_name
                    all_items.append(item)
    return all_items

def check_source_health(url):
    """Проверяет доступность источника и возвращает короткую диагностическую запись."""
    started = time.monotonic()
    try:
        response = fetch_url(url)
        entries = None
        if "forbes.ru" not in url:
            entries = len(feedparser.parse(response.content).entries)
        return {
            'url': url,
            'ok': True,
            'status_code': response.status_code,
            'elapsed_ms': round((time.monotonic() - started) * 1000),
            'entries': entries,
            'error': '',
        }
    except Exception as e:
        return {
            'url': url,
            'ok': False,
            'status_code': None,
            'elapsed_ms': round((time.monotonic() - started) * 1000),
            'entries': None,
            'error': str(e),
        }

def check_all_sources(file_path="feeds.json"):
    """Параллельно проверяет все настроенные RSS-источники."""
    categories = load_categories(file_path)

    sources = [
        (cat_name, url)
        for cat_name, urls in categories.items()
        for url in urls
    ]
    results = []
    with ThreadPoolExecutor(max_workers=SEARCH_MAX_WORKERS) as executor:
        future_to_source = {
            executor.submit(check_source_health, url): (cat_name, url)
            for cat_name, url in sources
        }
        for future in as_completed(future_to_source):
            cat_name, url = future_to_source[future]
            try:
                result = future.result()
            except Exception as e:
                result = {
                    'url': url,
                    'ok': False,
                    'status_code': None,
                    'elapsed_ms': 0,
                    'entries': None,
                    'error': str(e),
                }
            result['category'] = cat_name
            results.append(result)

    results.sort(key=lambda item: (item['ok'], item['category'], item['url']))
    return results

if __name__ == "__main__":
    d = fetch_category_digest()
    for cat, topics in d.items():
        print(f"--- {cat} ---")
        for t in topics:
            print(f"🚀 {t['main_title']} (Источников: {len(t['items'])})")
            for i in t['items']:
                print(f"  - {i['link']}")

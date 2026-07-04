import os
import re
import logging
import requests
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from .config import env_int

SEARXNG_BASE_URL = os.getenv("SEARXNG_BASE_URL", "http://host.docker.internal:8888")
SEARXNG_TIMEOUT_SECONDS = env_int("SEARXNG_TIMEOUT_SECONDS", 10)

# Стоп-слова для русского и английского
_STOP_WORDS = {
    # RU
    'и', 'в', 'на', 'с', 'по', 'для', 'из', 'от', 'до', 'при', 'об', 'о', 'за',
    'к', 'но', 'не', 'а', 'то', 'же', 'как', 'что', 'это', 'его', 'ее', 'их',
    'он', 'она', 'они', 'мы', 'вы', 'я', 'все', 'был', 'была', 'были', 'быть',
    'будет', 'есть', 'нет', 'так', 'или', 'уже', 'бы', 'свой', 'свою', 'своих',
    'который', 'которые', 'может', 'чем', 'где', 'когда', 'если', 'только',
    'еще', 'после', 'этот', 'этом', 'этой', 'эту', 'того', 'том', 'тому',
    'также', 'об', 'над', 'под', 'про', 'без', 'через', 'между', 'перед',
    # EN
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
    'has', 'have', 'had', 'not', 'that', 'this', 'it', 'as', 'he', 'she',
}


def extract_keywords(text: str, min_length: int = 3) -> list[str]:
    """Разбивает тему на значимые ключевые слова, убирает стоп-слова."""
    words = re.findall(r'[a-zA-Zа-яА-ЯёЁ]+', text.lower())
    return [w for w in words if len(w) >= min_length and w not in _STOP_WORDS]


def build_query(topic: str) -> str:
    """Строит поисковый запрос из ключевых слов темы."""
    keywords = extract_keywords(topic)
    # Берём не более 4 самых длинных слов для точности
    keywords.sort(key=len, reverse=True)
    return ' '.join(keywords[:4]) if keywords else topic


def parse_published_ts(value) -> float | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        if raw.endswith('Z'):
            raw = raw[:-1] + '+00:00'
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            try:
                dt = parsedate_to_datetime(value)
            except (TypeError, ValueError):
                return None
    else:
        return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def search(query: str, categories: str = 'news', language: str = 'ru-RU',
           limit: int = 10, time_range: str | None = None,
           max_age_hours: int | None = None) -> list[dict]:
    """
    Поиск через SearXNG JSON API.
    Возвращает список {'title', 'url', 'content', 'source'}.
    Требует включённого format=json в settings.yml SearXNG.
    """
    try:
        params = {
            'q':          query,
            'format':     'json',
            'categories': categories,
            'language':   language,
        }
        if time_range:
            params['time_range'] = time_range

        resp = requests.get(
            f"{SEARXNG_BASE_URL}/search",
            params=params,
            timeout=SEARXNG_TIMEOUT_SECONDS,
            headers={'User-Agent': 'UTrendsBot/1.0'}
        )
        resp.raise_for_status()
        data = resp.json()

        results = []
        cutoff_ts = time.time() - max_age_hours * 3600 if max_age_hours else None
        for r in data.get('results', []):
            published = r.get('publishedDate', '')
            published_ts = parse_published_ts(published)
            if cutoff_ts and (published_ts is None or published_ts <= cutoff_ts):
                continue
            results.append({
                'title':     r.get('title', ''),
                'url':       r.get('url', ''),
                'content':   r.get('content', ''),
                'source':    r.get('engine', 'searxng'),
                'published': published,
                'published_ts': published_ts,
            })
            if len(results) >= limit:
                break
        return results

    except Exception as e:
        logging.warning(f"SearXNG search error for '{query}': {e}")
        return []

import requests
import datetime
import logging

# Страницы которые всегда в топе, но не несут информации
_BLACKLIST = {
    'заглавная страница', 'wikipedia', 'служебная', 'special:search',
    'main page', 'специальная', 'portal:', 'портал:'
}

def _fetch_for_date(date: 'datetime.date', lang: str) -> list:
    url = (
        f"https://wikimedia.org/api/rest_v1/metrics/pageviews/top/"
        f"{lang}.wikipedia/all-access/"
        f"{date.year}/{date.month:02d}/{date.day:02d}"
    )
    resp = requests.get(url, timeout=10, headers={'User-Agent': 'UTrendsBot/1.0'})
    resp.raise_for_status()
    return resp.json()['items'][0]['articles']


def fetch_wikipedia_trending(lang: str = 'ru', limit: int = 10) -> list[dict]:
    """Возвращает топ просматриваемых статей Википедии.
    Пробует вчера → позавчера (API обновляется с задержкой 24-48ч).
    """
    today = datetime.date.today()
    raw_articles = None
    used_date = None

    for days_back in (1, 2, 3):
        candidate = today - datetime.timedelta(days=days_back)
        try:
            raw_articles = _fetch_for_date(candidate, lang)
            used_date = candidate
            break
        except Exception as e:
            logging.warning(f"Wikipedia {candidate}: {e}")

    if raw_articles is None:
        logging.error("Wikipedia trending: no data available for last 3 days")
        return []

    results = []
    for a in raw_articles:
        title = a['article'].replace('_', ' ')
        lower = title.lower()
        if any(bl in lower for bl in _BLACKLIST):
            continue
        results.append({
            'title':    title,
            'views':    a['views'],
            'rank':     a['rank'],
            'url':      f"https://{lang}.wikipedia.org/wiki/{a['article']}",
            'date':     str(used_date),
        })
        if len(results) >= limit:
            break

    return results

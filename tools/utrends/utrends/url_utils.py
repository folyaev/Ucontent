from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


TRACKING_QUERY_PARAMS = {"fbclid", "gclid", "yclid", "ysclid"}


def normalize_article_url(url: str) -> str:
    """Return a stable URL key for notification deduplication."""
    url = (url or "").strip()
    if not url:
        return ""

    try:
        parts = urlsplit(url)
        query = urlencode([
            (key, value)
            for key, value in parse_qsl(parts.query, keep_blank_values=True)
            if not key.lower().startswith("utm_") and key.lower() not in TRACKING_QUERY_PARAMS
        ])
        path = parts.path.rstrip("/") or "/"
        return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, query, ""))
    except ValueError:
        return url

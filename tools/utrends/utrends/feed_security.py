import ipaddress
import socket
from urllib.parse import urljoin, urlsplit

import requests


MAX_REDIRECTS = 5


def _is_public_ip(address: str) -> bool:
    return ipaddress.ip_address(address).is_global


def validate_public_http_url(url: str, resolver=socket.getaddrinfo) -> None:
    """Reject URLs that can reach local, private, or reserved network addresses."""
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        raise ValueError("Разрешены только ссылки http:// и https://.")
    if not parts.hostname:
        raise ValueError("В ссылке отсутствует имя хоста.")
    if parts.username or parts.password:
        raise ValueError("Ссылки с логином или паролем не поддерживаются.")

    try:
        addresses = {
            result[4][0]
            for result in resolver(parts.hostname, parts.port, type=socket.SOCK_STREAM)
        }
    except socket.gaierror as exc:
        raise ValueError("Не удалось определить IP-адрес источника.") from exc

    if not addresses or any(not _is_public_ip(address) for address in addresses):
        raise ValueError("Локальные и служебные сетевые адреса запрещены.")


def fetch_public_feed(url: str, timeout: int, max_redirects: int = MAX_REDIRECTS) -> bytes:
    """Fetch a feed while validating every redirect target against SSRF."""
    current_url = url
    for _ in range(max_redirects + 1):
        validate_public_http_url(current_url)
        response = requests.get(
            current_url,
            headers={"User-Agent": "UTrendsBot/1.0 (RSS feed validation)"},
            timeout=timeout,
            allow_redirects=False,
        )
        if response.is_redirect or response.is_permanent_redirect:
            location = response.headers.get("Location")
            if not location:
                raise ValueError("Источник вернул редирект без адреса.")
            current_url = urljoin(current_url, location)
            continue
        response.raise_for_status()
        return response.content
    raise ValueError("Слишком много редиректов при загрузке RSS-ленты.")

import asyncio
import sqlite3
import os
import json
import feedparser
import logging
import time
from typing import cast
from dotenv import load_dotenv
from aiogram import Bot, Dispatcher, types
from aiogram.filters import Command
from aiogram.enums import ParseMode
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.types import URLInputFile, InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.exceptions import TelegramBadRequest, TelegramNetworkError
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from . import blogger_digest, rich_message as rm, rss_parser, searxng_client, trends_parser, wiki_trends
from .config import env_int
from .db_backup import create_backup
from .feed_security import fetch_public_feed
from .logging_utils import configure_logging
from .migrations import apply_migrations
from .rate_limit import RateLimiter
from .telegram_html import html_link, html_text
from .text_match import title_signature, tracked_topic_matches
from .time_window import format_window, parse_window_arg as parse_time_window_arg
from .url_utils import normalize_article_url

load_dotenv()

configure_logging(logging.INFO)

# ── Constants ──────────────────────────────────────────────────────────────────
BOT_TOKEN             = os.getenv("BOT_TOKEN")
ADMIN_CHAT_IDS        = {
    int(chat_id)
    for chat_id in os.getenv("ADMIN_CHAT_IDS", "").split(",")
    if chat_id.strip().lstrip("-").isdigit()
}
DIGEST_INTERVAL_HOURS  = env_int("DIGEST_INTERVAL_HOURS", 6)
WATCHDOG_INTERVAL_HRS  = env_int("WATCHDOG_INTERVAL_HOURS", 1)
WATCHDOG_WINDOW_HRS    = env_int("WATCHDOG_WINDOW_HOURS", 2)
DIGEST_WINDOW_HRS      = env_int("DIGEST_WINDOW_HOURS", 24)
MAX_DIGEST_WINDOW_HRS  = env_int("MAX_DIGEST_WINDOW_HOURS", 168, minimum=1)
SEARCH_WINDOW_HRS      = env_int("SEARCH_WINDOW_HOURS", 48)
SEARCH_TIMEOUT_SECONDS = env_int("SEARCH_TIMEOUT_SECONDS", 30)
TELEGRAM_TIMEOUT_SECONDS = env_int("TELEGRAM_TIMEOUT_SECONDS", 30)
FORCE_TRENDS_LIMIT     = env_int("FORCE_TRENDS_LIMIT", 5)
GOOGLE_DIGEST_MIN_TRAFFIC = env_int("GOOGLE_DIGEST_MIN_TRAFFIC", 5000, minimum=0)
GOOGLE_DIGEST_LIMIT    = env_int("GOOGLE_DIGEST_LIMIT", 10, minimum=1)
WIKI_DIGEST_MIN_VIEWS  = env_int("WIKI_DIGEST_MIN_VIEWS", 5000, minimum=0)
WIKI_DIGEST_LIMIT      = env_int("WIKI_DIGEST_LIMIT", 10, minimum=1)
RSS_FETCH_TIMEOUT_SECONDS = env_int("RSS_FETCH_TIMEOUT_SECONDS", 5)
SEARCH_COOLDOWN_SECONDS  = env_int("SEARCH_COOLDOWN_SECONDS", 30)
DIGEST_COOLDOWN_SECONDS  = env_int("DIGEST_COOLDOWN_SECONDS", 60)
FORCE_COOLDOWN_SECONDS   = env_int("FORCE_COOLDOWN_SECONDS", 60)
WIKI_COOLDOWN_SECONDS    = env_int("WIKI_COOLDOWN_SECONDS", 30)
FEEDHEALTH_COOLDOWN_SECONDS = env_int("FEEDHEALTH_COOLDOWN_SECONDS", 300)
BACKUP_INTERVAL_HOURS = env_int("BACKUP_INTERVAL_HOURS", 24)
BACKUP_RETENTION_COUNT = env_int("BACKUP_RETENTION_COUNT", 7)
BACKUP_COOLDOWN_SECONDS = env_int("BACKUP_COOLDOWN_SECONDS", 300)
RADAR_PRIORITY_DOMAINS = (
    "youtube.com",
    "youtu.be",
    "vk.com",
    "vkvideo.ru",
    "ok.ru",
    "odnoklassniki.ru",
    "x.com",
    "twitter.com",
)
STALE_DAYS            = env_int("STALE_DAYS", 14)   # через сколько дней без новостей спрашивать о подписке
# Абсолютные пути — не зависят от рабочей директории при запуске
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR   = os.path.dirname(PACKAGE_DIR)
DB_PATH    = os.path.join(BASE_DIR, "trends.db")
FEEDS_PATH = os.path.join(BASE_DIR, "feeds.json")
BLOGGERS_PATH = os.path.join(BASE_DIR, "bloggers.json")
NEWS_CHANNELS_PATH = os.path.join(BASE_DIR, "news_channels.json")
BACKUP_DIR = os.getenv("BACKUP_DIR", os.path.join(BASE_DIR, "backups"))

# Временное хранилище URL для /addfeed (chat_id -> url)
pending_feeds: dict[int, str] = {}

# Пагинация поиска: chat_id -> {results, query, page}
search_sessions: dict[int, dict] = {}
feedhealth_sessions: dict[int, dict] = {}
SEARCH_PAGE_SIZE = 10
FEEDHEALTH_PAGE_SIZE = 8
BLOGGER_REPEATED_TOPIC_LIMIT = env_int("BLOGGER_REPEATED_TOPIC_LIMIT", 3, minimum=1)
BLOGGER_EXAMPLES_PER_TOPIC = env_int("BLOGGER_EXAMPLES_PER_TOPIC", 2, minimum=1)
BLOGGER_LATEST_LIMIT = env_int("BLOGGER_LATEST_LIMIT", 5, minimum=0)
BLOGGER_SINGLE_TOPIC_LIMIT = env_int("BLOGGER_SINGLE_TOPIC_LIMIT", 5, minimum=0)
BLOGGER_SNIPPET_CHARS = env_int("BLOGGER_SNIPPET_CHARS", 90, minimum=0)
BLOGGER_CHAPTERS_PER_EXAMPLE = env_int("BLOGGER_CHAPTERS_PER_EXAMPLE", 2, minimum=0)
heavy_command_limiter = RateLimiter()

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN не задан! Проверьте файл .env")
BOT_TOKEN = str(BOT_TOKEN)

bot = Bot(
    token=BOT_TOKEN,
    session=AiohttpSession(timeout=TELEGRAM_TIMEOUT_SECONDS),
    default=DefaultBotProperties(parse_mode=ParseMode.HTML)
)
dp  = Dispatcher()


async def tg_send(coro, retries: int = 3, delay: float = 3.0):
    """Wrapper: повторяем Telegram-вызов при таймауте/сети."""
    for attempt in range(1, retries + 1):
        try:
            return await coro
        except TelegramNetworkError as e:
            if attempt == retries:
                logging.error(f"tg_send failed after {retries} attempts: {e}")
                raise
            logging.warning(f"TelegramNetworkError (attempt {attempt}/{retries}): {e}. Retry in {delay}s")
            await asyncio.sleep(delay * attempt)

# ── DB Setup ───────────────────────────────────────────────────────────────────
def init_db():
    applied = apply_migrations(DB_PATH)
    if applied:
        logging.info(f"Applied DB migrations: {applied}")

init_db()

# ── Helpers ────────────────────────────────────────────────────────────────────
def get_blocked(chat_id: int) -> list[str]:
    """Возвращает список заблокированных тем для chat_id в нижнем регистре."""
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT topic FROM blocked_topics WHERE chat_id = ?", (chat_id,))
        return [row[0].lower() for row in cursor.fetchall()]

def get_user_excluded(chat_id: int) -> list[str]:
    """Возвращает объединённый список заблокированных И отслеживаемых тем.
    Отслеживаемые темы не нужно показывать в общей ленте — watchdog сам пришлёт алерт.
    """
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT topic FROM blocked_topics WHERE chat_id = ? "
            "UNION SELECT topic FROM tracked_topics WHERE chat_id = ?",
            (chat_id, chat_id)
        )
        return [row[0].lower() for row in cursor.fetchall()]

def is_blocked(title: str, blocked: list[str]) -> bool:
    t = title.lower()
    return any(b in t or t in b for b in blocked)

def is_priority_radar_source(item: dict) -> bool:
    link = (item.get('link') or item.get('url') or '').lower()
    source = (item.get('source_name') or item.get('source') or '').lower()
    return any(domain in link or domain in source for domain in RADAR_PRIORITY_DOMAINS)

def radar_sort_key(item: dict) -> tuple[int, float]:
    return (0 if is_priority_radar_source(item) else 1, -(item.get('time') or 0))

def is_admin(chat_id: int) -> bool:
    return chat_id in ADMIN_CHAT_IDS

def load_feed_categories() -> list[str]:
    return list(rss_parser.load_categories(FEEDS_PATH).keys())

def get_enabled_categories(chat_id: int) -> set[str]:
    categories = load_feed_categories()
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT category, enabled FROM user_source_preferences WHERE chat_id = ?",
            (chat_id,),
        ).fetchall()
    prefs = {category: bool(enabled) for category, enabled in rows}
    return {category for category in categories if prefs.get(category, True)}

def get_digest_seen_urls(chat_id: int) -> set[str]:
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT url FROM digest_seen_articles WHERE chat_id = ?",
            (chat_id,),
        ).fetchall()
    return {row[0] for row in rows}

def mark_digest_seen(chat_id: int, urls: list[str]) -> None:
    normalized = sorted({normalize_article_url(url) for url in urls if normalize_article_url(url)})
    if not normalized:
        return
    with sqlite3.connect(DB_PATH) as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO digest_seen_articles (chat_id, url) VALUES (?, ?)",
            [(chat_id, url) for url in normalized],
        )
        conn.commit()

def item_digest_url(item: dict) -> str:
    return normalize_article_url(item.get('link') or item.get('url') or '')

def filter_digest_topics_for_fresh(topics: list[dict], seen_urls: set[str]) -> list[dict]:
    fresh_topics = []
    for topic in topics:
        fresh_items = [
            item for item in topic.get('items', [])
            if item_digest_url(item) and item_digest_url(item) not in seen_urls
        ]
        if not fresh_items:
            continue
        fresh_topic = dict(topic)
        fresh_topic['items'] = fresh_items
        fresh_topics.append(fresh_topic)
    return fresh_topics

def collect_topic_urls(topic: dict) -> list[str]:
    return [item.get('link') or item.get('url') or '' for item in topic.get('items', [])]

def filter_blogger_digest_for_fresh(digest: dict, seen_urls: set[str]) -> dict:
    def fresh_clusters(clusters: list[dict], require_repeated: bool) -> list[dict]:
        result = []
        for cluster in clusters:
            fresh_items = [
                item for item in cluster.get("items", [])
                if item_digest_url(item) and item_digest_url(item) not in seen_urls
            ]
            if not fresh_items:
                continue
            channels = {item.get("channel") for item in fresh_items if item.get("channel")}
            fresh_cluster = dict(cluster)
            fresh_cluster["items"] = fresh_items
            fresh_cluster["channel_count"] = len(channels)
            fresh_cluster["item_count"] = len(fresh_items)
            fresh_cluster["video_count"] = len({
                item.get("video_url") or item_digest_url(item)
                for item in fresh_items
                if item.get("video_url") or item_digest_url(item)
            })
            fresh_cluster["is_repeated"] = fresh_cluster["channel_count"] > 1 or fresh_cluster["video_count"] > 1
            if require_repeated and not fresh_cluster["is_repeated"]:
                continue
            result.append(fresh_cluster)
        return result

    fresh_videos = [
        item for item in digest.get("videos", [])
        if item_digest_url(item) and item_digest_url(item) not in seen_urls
    ]
    fresh_latest = [
        item for item in digest.get("latest", [])
        if item_digest_url(item) and item_digest_url(item) not in seen_urls
    ]
    fresh_repeated = []
    for cluster in digest.get("repeated", []):
        fresh_items = [
            item for item in cluster.get("items", [])
            if item_digest_url(item) and item_digest_url(item) not in seen_urls
        ]
        channels = {item.get("channel") for item in fresh_items if item.get("channel")}
        if len(channels) < 2:
            continue
        fresh_cluster = dict(cluster)
        fresh_cluster["items"] = fresh_items
        fresh_cluster["channel_count"] = len(channels)
        fresh_cluster["item_count"] = len(fresh_items)
        fresh_repeated.append(fresh_cluster)
    topic_clusters = fresh_clusters(digest.get("topic_clusters", []), require_repeated=False)
    repeated_topics = [cluster for cluster in topic_clusters if cluster.get("is_repeated")]
    single_topics = [cluster for cluster in topic_clusters if not cluster.get("is_repeated")]
    return {
        "videos": fresh_videos,
        "repeated": fresh_repeated,
        "topic_clusters": topic_clusters,
        "repeated_topics": repeated_topics,
        "single_topics": single_topics,
        "latest": fresh_latest,
    }

def collect_blogger_urls(digest: dict) -> list[str]:
    urls = []
    for item in digest.get("videos", []):
        urls.append(item.get("link") or item.get("url") or "")
    return urls

def make_sources_markup(chat_id: int) -> InlineKeyboardMarkup:
    enabled = get_enabled_categories(chat_id)
    rows = []
    for category in load_feed_categories():
        mark = "✅" if category in enabled else "⬜"
        rows.append([InlineKeyboardButton(text=f"{mark} {category}", callback_data=safe_cb("source", category))])
    rows.append([InlineKeyboardButton(text="↩️ Назад", callback_data="sources_close")])
    return InlineKeyboardMarkup(inline_keyboard=rows)

async def enforce_rate_limit(message: types.Message, command: str, cooldown_seconds: int) -> bool:
    retry_after = heavy_command_limiter.retry_after(message.chat.id, command, cooldown_seconds)
    if retry_after:
        await message.reply(f"⏳ Повторите команду через {retry_after} сек.")
        return False
    return True

def parse_window_arg(text: str | None) -> tuple[int, None] | tuple[None, str]:
    return parse_time_window_arg(text, DIGEST_WINDOW_HRS, MAX_DIGEST_WINDOW_HRS)


def callback_message(callback_query: types.CallbackQuery) -> types.Message:
    return cast(types.Message, callback_query.message)


def callback_data(callback_query: types.CallbackQuery) -> str:
    return callback_query.data or ""


def merge_search_results(rss_raw: list[dict], searx_raw: list[dict]) -> list[dict]:
    seen_urls: set[str] = set()
    seen_titles: set[str] = set()
    results: list[dict] = []
    for r in rss_raw:
        url = r.get('link', '')
        url_key = normalize_article_url(url)
        title_key = title_signature(r.get('title', ''))
        if url_key and url_key not in seen_urls and title_key not in seen_titles:
            seen_urls.add(url_key)
            if title_key:
                seen_titles.add(title_key)
            results.append({'title': r['title'], 'url': url, 'source': r.get('source', r.get('source_name', ''))})
    for r in searx_raw:
        url = r.get('url', '')
        url_key = normalize_article_url(url)
        title_key = title_signature(r.get('title', ''))
        if url_key and url_key not in seen_urls and title_key not in seen_titles:
            seen_urls.add(url_key)
            if title_key:
                seen_titles.add(title_key)
            results.append({'title': r['title'], 'url': url, 'source': r.get('source', 'searxng')})
    return results

def render_search_page(query: str, results: list[dict], page: int, partial_notice: str = "") -> tuple[str, InlineKeyboardMarkup]:
    start = page * SEARCH_PAGE_SIZE
    end = start + SEARCH_PAGE_SIZE
    page_results = results[start:end]
    suffix = f" (стр. {page + 1})" if page else ""
    text = f"🔎 <b>Результаты по «{html_text(query)}»</b>{suffix}:\n\n"
    if partial_notice:
        text += f"<i>{html_text(partial_notice)}</i>\n\n"
    for r in page_results:
        text += f"🔹 {html_link(r['url'], r['title'])} {html_text(r['source'])}\n"

    remaining = len(results) - end
    rows = [[
        InlineKeyboardButton(text="🔔", callback_data=safe_cb("track", query)),
        InlineKeyboardButton(text="🙈", callback_data=safe_cb("ignore", query)),
    ]]
    if remaining > 0:
        rows.append([InlineKeyboardButton(text=f"➡️ Ещё {min(remaining, SEARCH_PAGE_SIZE)}", callback_data="search_next")])
        text += f"\n<i>…и ещё {remaining} результатов.</i>"
    return text, InlineKeyboardMarkup(inline_keyboard=rows)

def render_feedhealth_page(results: list[dict], page: int) -> tuple[str, InlineKeyboardMarkup | None]:
    failed = [item for item in results if not item['ok']]
    successful = len(results) - len(failed)
    text = (
        "🩺 <b>Состояние RSS-источников</b>\n\n"
        f"✅ Доступны: <b>{successful}</b>\n"
        f"❌ С ошибками: <b>{len(failed)}</b>\n"
        f"📚 Всего: <b>{len(results)}</b>"
    )
    if failed:
        start = page * FEEDHEALTH_PAGE_SIZE
        end = start + FEEDHEALTH_PAGE_SIZE
        page_items = failed[start:end]
        text += f"\n\n<b>Проблемные источники</b> (стр. {page + 1}):\n"
        for item in page_items:
            error = item['error'][:180]
            text += (
                f"\n• <b>{html_text(item['category'])}</b>\n"
                f"<code>{html_text(item['url'])}</code>\n"
                f"{html_text(error)}"
            )
        remaining = len(failed) - end
        if remaining > 0:
            text += f"\n\n<i>…и ещё {remaining} проблемных источников.</i>"
            return text, InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text=f"➡️ Ещё {min(remaining, FEEDHEALTH_PAGE_SIZE)}", callback_data="feedhealth_next")
            ]])
    return text, None


def render_google_trends_digest(trends: list[dict]) -> str:
    text = (
        f"🔎 <b>Google Trends: больше {GOOGLE_DIGEST_MIN_TRAFFIC:,} запросов</b>\n\n"
    ).replace(",", " ")
    for idx, trend in enumerate(trends[:GOOGLE_DIGEST_LIMIT], 1):
        traffic = trend.get("traffic") or ""
        traffic_text = f" — <i>{html_text(traffic)}</i>" if traffic else ""
        text += f"{idx}. <b>{html_text(trend['title'])}</b>{traffic_text}\n"
        for news in (trend.get("news") or [])[:2]:
            text += f"🔹 {html_link(news['url'], news['title'])}\n"
        text += "\n"
    return text.rstrip()


def render_wiki_digest(articles: list[dict]) -> str:
    text = (
        f"📚 <b>Русская Википедия: больше {WIKI_DIGEST_MIN_VIEWS:,} просмотров</b>\n\n"
    ).replace(",", " ")
    for idx, article in enumerate(articles[:WIKI_DIGEST_LIMIT], 1):
        views = f"{article['views']:,}".replace(",", " ")
        text += f"{idx}. {html_link(article['url'], article['title'])} — {views}\n"
    return text.rstrip()


def render_blogger_digest(
    digest: dict,
    title: str = "Блогеры и YouTube-каналы",
    include_latest: bool = True,
    include_single_topics: bool = True,
) -> str:
    repeated = digest.get("repeated_topics") or digest.get("repeated", [])
    single_topics = digest.get("single_topics", [])
    latest = digest.get("latest", [])
    total = len(digest.get("videos", []))
    text = (
        f"🎥 <b>{html_text(title)}</b>\n\n"
        f"📊 Свежих видео: <b>{total}</b>\n"
    )

    if repeated:
        text += "\n🔥 <b>Повторяющиеся темы</b>\n"
        for idx, cluster in enumerate(repeated[:BLOGGER_REPEATED_TOPIC_LIMIT], 1):
            text += (
                f"\n{idx}. <b>{html_text(cluster['main_title'])}</b>\n"
                f"Каналов: <b>{cluster['channel_count']}</b>, видео: <b>{cluster['item_count']}</b>\n"
            )
            for item_idx, item in enumerate(cluster["items"][:BLOGGER_EXAMPLES_PER_TOPIC]):
                timecodes_text = f" ⏱ {html_text(item['start_time'])}" if item.get("start_time") else ""
                link_title = item.get("video_title") or item.get("title") or cluster["main_title"]
                text += (
                    f"🔗 {html_link(item['link'], link_title)} "
                    f"{html_text(item['channel'])}{timecodes_text}\n"
                )
                chapters = item.get("chapters") or []
                if item_idx == 0 and BLOGGER_CHAPTERS_PER_EXAMPLE and chapters:
                    chapter_bits = [
                        f"{chapter['start_time']} {chapter['title']}"
                        for chapter in chapters[:BLOGGER_CHAPTERS_PER_EXAMPLE]
                    ]
                    text += f"<i>{html_text(' / '.join(chapter_bits))}</i>\n"
                elif item_idx == 0 and BLOGGER_SNIPPET_CHARS and item.get("description_snippet"):
                    snippet = item["description_snippet"][:BLOGGER_SNIPPET_CHARS].rstrip()
                    if len(item["description_snippet"]) > BLOGGER_SNIPPET_CHARS:
                        snippet += "..."
                    text += f"<i>{html_text(snippet)}</i>\n"
            hidden_items = max(0, cluster.get("item_count", 0) - BLOGGER_EXAMPLES_PER_TOPIC)
            if hidden_items:
                text += f"<i>...ещё {hidden_items} видео по теме</i>\n"
        hidden_topics = len(repeated) - BLOGGER_REPEATED_TOPIC_LIMIT
        if hidden_topics > 0:
            text += f"\n<i>...и ещё {hidden_topics} повторяющихся тем.</i>\n"
    else:
        text += "\n🔥 Повторяющихся тем за окно дайджеста не найдено.\n"

    if include_single_topics and single_topics and BLOGGER_SINGLE_TOPIC_LIMIT:
        text += "\n▫️ <b>Одиночные темы</b>\n"
        for cluster in single_topics[:BLOGGER_SINGLE_TOPIC_LIMIT]:
            item = cluster["items"][0]
            timecodes_text = f" ⏱ {html_text(item['start_time'])}" if item.get("start_time") else ""
            link_title = item.get("video_title") or item.get("title") or cluster["main_title"]
            text += (
                f"• <b>{html_text(cluster['main_title'])}</b> — "
                f"{html_link(item['link'], link_title)} "
                f"{html_text(item.get('channel', ''))}{timecodes_text}\n"
            )
        hidden_single = len(single_topics) - BLOGGER_SINGLE_TOPIC_LIMIT
        if hidden_single > 0:
            text += f"<i>...и ещё {hidden_single} одиночных тем.</i>\n"

    if include_latest and latest and BLOGGER_LATEST_LIMIT:
        text += "\n🆕 <b>Что вышло</b>\n"
        for item in latest[:BLOGGER_LATEST_LIMIT]:
            timecodes = item.get("timecodes") or []
            timecodes_text = f" ⏱ {html_text(', '.join(timecodes[:2]))}" if timecodes else ""
            text += (
                f"🔹 {html_link(item['link'], item['title'])} "
                f"{html_text(item['channel'])}{timecodes_text}\n"
            )
        hidden_latest = len(latest) - BLOGGER_LATEST_LIMIT
        if hidden_latest > 0:
            text += f"<i>...и ещё {hidden_latest} свежих видео.</i>\n"
    return text

def safe_cb(prefix: str, text: str) -> str:
    """Формирует callback_data ≤ 64 байт, корректно обрезая UTF-8 текст."""
    max_payload = 64 - len(prefix.encode()) - 1  # 1 байт на разделитель |
    encoded = text.encode('utf-8')
    if len(encoded) <= max_payload:
        return f"{prefix}|{text}"
    truncated = encoded[:max_payload].decode('utf-8', errors='ignore')
    return f"{prefix}|{truncated}"

def make_subs_markup(topics: list) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"❌ {topic}", callback_data=f"unfollow|{track_id}")]
        for track_id, topic in topics
    ])

def make_ignored_markup(topics: list) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"👁 {topic}", callback_data=f"unblock|{block_id}")]
        for block_id, topic in topics
    ])

def split_message(text: str, limit: int = 4000) -> list[str]:
    """Разбивает длинное сообщение на части по границам строк."""
    lines = text.split('\n')
    chunks, current = [], ""
    for line in lines:
        if len(current) + len(line) + 1 > limit:
            if current:
                chunks.append(current.rstrip('\n'))
            current = line + '\n'
        else:
            current += line + '\n'
    if current.strip():
        chunks.append(current.rstrip('\n'))
    return chunks or [text[:limit]]

async def send_long_message(chat_id: int, text: str, **kwargs) -> None:
    """Отправляет сообщение, разбивая на части если длиннее лимита Telegram."""
    parts = split_message(text)
    for i, part in enumerate(parts):
        await bot.send_message(chat_id, part, **kwargs)
        if len(parts) > 1 and i < len(parts) - 1:
            await asyncio.sleep(0.3)


async def schedule_delete(chat_id: int, message_id: int, delay: float = 60.0) -> None:
    """Удаляет сообщение через `delay` секунд, игнорируя ошибки."""
    await asyncio.sleep(delay)
    try:
        await bot.delete_message(chat_id=chat_id, message_id=message_id)
    except Exception:
        pass


async def try_send_rich(chat_id: int, blocks: list, fallback_html: str, **kwargs) -> None:
    """
    Пытается отправить Rich Message (Bot API 10.1).
    При ошибке — fallback на обычный send_long_message с HTML.
    """
    token = BOT_TOKEN
    if token is None:
        await send_long_message(chat_id, fallback_html, disable_web_page_preview=True)
        return
    result = await rm.send_rich_message(token, chat_id, blocks, **kwargs)
    if result is None:
        # fallback
        await send_long_message(chat_id, fallback_html, disable_web_page_preview=True)

async def send_video_stats(
    chat_id: int,
    status_msg,
    file_path: str,
    title: str,
    window_hours: int,
    include_single_topics: bool,
    include_latest: bool = False,
    require_repeated: bool = False,
) -> None:
    if not os.path.exists(file_path):
        await bot.edit_message_text(
            f"⚠️ Файл источников не найден: <code>{html_text(os.path.basename(file_path))}</code>",
            chat_id=status_msg.chat.id,
            message_id=status_msg.message_id,
            parse_mode=ParseMode.HTML,
        )
        return

    try:
        digest = await asyncio.to_thread(
            blogger_digest.build_blogger_digest,
            file_path,
            window_hours,
        )
    except Exception as e:
        logging.error(f"Video stats fetch error for {file_path}: {e}")
        await bot.edit_message_text(
            f"⚠️ Не удалось собрать статистику: <code>{html_text(e)}</code>",
            chat_id=status_msg.chat.id,
            message_id=status_msg.message_id,
            parse_mode=ParseMode.HTML,
        )
        return

    if not digest.get("videos"):
        await bot.edit_message_text(
            "ℹ️ За текущее окно видео не найдено.",
            chat_id=status_msg.chat.id,
            message_id=status_msg.message_id,
        )
        return

    repeated_topics = digest.get("repeated_topics") or digest.get("repeated")
    if require_repeated and not repeated_topics:
        await bot.edit_message_text(
            "ℹ️ Повторяющихся тем за текущее окно не найдено.",
            chat_id=status_msg.chat.id,
            message_id=status_msg.message_id,
        )
        return

    full_title = f"{title} за {format_window(window_hours)}"
    text = render_blogger_digest(
        digest,
        title=full_title,
        include_latest=include_latest,
        include_single_topics=include_single_topics,
    )
    blocks = rm.build_blocks_blogger(
        digest,
        title=full_title,
        repeated_limit=BLOGGER_REPEATED_TOPIC_LIMIT,
        examples_per_topic=BLOGGER_EXAMPLES_PER_TOPIC,
        snippet_chars=BLOGGER_SNIPPET_CHARS,
        chapters_per_example=BLOGGER_CHAPTERS_PER_EXAMPLE,
        latest_limit=BLOGGER_LATEST_LIMIT,
        include_latest=include_latest,
        include_single_topics=include_single_topics,
        single_topic_limit=BLOGGER_SINGLE_TOPIC_LIMIT,
    )
    try:
        await bot.delete_message(chat_id=status_msg.chat.id, message_id=status_msg.message_id)
    except Exception:
        pass
    await try_send_rich(chat_id, blocks, fallback_html=text)

async def safe_answer_callback(callback_query: types.CallbackQuery, *args, **kwargs) -> None:
    try:
        await bot.answer_callback_query(callback_query.id, *args, **kwargs)
    except TelegramBadRequest as e:
        if "query is too old" in str(e) or "query ID is invalid" in str(e):
            logging.info(f"Ignored expired callback query: id={callback_query.id}")
            return
        raise

# ── Handlers ───────────────────────────────────────────────────────────────────
@dp.errors()
async def telegram_error_handler(event: types.ErrorEvent) -> bool:
    if isinstance(event.exception, TelegramNetworkError):
        logging.warning(f"Telegram API network error while processing update: {event.exception}")
        return True
    return False


@dp.message(Command("start"))
async def start_handler(message: types.Message):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT OR IGNORE INTO subscribers (chat_id) VALUES (?)", (message.chat.id,))
        conn.commit()

    await message.reply(
        "Привет! Я твой личный трекер трендов и новостей из RSS-лент! 📰\n\n"
        "Вот что я умею:\n"
        f"🔸 Каждые {DIGEST_INTERVAL_HOURS} часов буду присылать <b>Сводный Дайджест</b> самых обсуждаемых тем.\n"
        "🔸 <b>/digest</b> или <b>/digest 3d</b> — собрать дайджест за окно.\n"
        "🔸 <b>/fresh</b> или <b>/fresh 12h</b> — только новое во fresh-дайджестах.\n"
        "🔸 <b>/bloggers</b> или <b>/bloggers 6d</b> — статистика тем у блогеров.\n"
        "🔸 <b>/search запрос</b> — поиск по всем источникам за последние 48 часов.\n"
        "🔸 <b>/force</b> — проверить горячие поисковые тренды из Google Trends (Россия).\n"
        "🔸 <b>/follow тема</b> — подписаться на тему напрямую (аналог кнопки 🔔).\n"
        "🔸 <b>/subs</b> — список тем, за которыми вы следите.\n"
        "🔸 <b>/ignored</b> — список скрытых тем (можно разблокировать).\n"
        "🔸 <b>/sources</b> — включить или отключить категории источников.\n"
        "🔸 <b>/addfeed URL</b> — добавить RSS-ленту в источники (для администраторов).\n"
        "🔸 <b>/feedhealth</b> — проверить RSS-источники (для администраторов).\n"
        "🔸 <b>/backup</b> — создать резервную копию БД (для администраторов).\n"
        "🔸 <b>/wiki</b> — топ читаемых статей Русской Википедии за вчера.\n"
        "🔸 <b>/stop</b> — отписаться от автоматического дайджеста.\n"
        "🔸 <b>/help</b> — показать это сообщение ещё раз.",
        parse_mode=ParseMode.HTML
    )


@dp.message(Command("help"))
async def help_handler(message: types.Message):
    await tg_send(message.reply(
        "📖 <b>Список команд:</b>\n\n"
        "🔸 <b>/start</b> — подписаться на дайджест.\n"
        "🔸 <b>/stop</b> — отписаться от автоматического дайджеста.\n"
        f"🔸 <b>/digest</b> — дайджест за последние {DIGEST_WINDOW_HRS} часов. Можно: <code>/digest 3d</code>.\n"
        "🔸 <b>/fresh</b> — только новое во fresh-дайджестах. Можно: <code>/fresh 12h</code>.\n"
        "🔸 <b>/bloggers</b> — статистика тем у блогеров. Можно: <code>/bloggers 6d</code>.\n"
        "🔸 <b>/search запрос</b> — поиск по RSS-лентам за последние 48 часов.\n"
        "🔸 <b>/force</b> — принудительно получить тренды из Google Trends.\n"
        "🔸 <b>/follow тема</b> — подписаться на тему: <code>/follow Путин Сочи</code>.\n"
        "🔸 <b>/subs</b> — просмотр и удаление отслеживаемых тем.\n"
        "🔸 <b>/ignored</b> — скрытые темы (можно разблокировать).\n"
        "🔸 <b>/sources</b> — категории RSS-источников.\n"
        "🔸 <b>/addfeed URL</b> — добавить RSS-ленту в источники (для администраторов).\n"
        "🔸 <b>/feedhealth</b> — проверить RSS-источники (для администраторов).\n"
        "🔸 <b>/backup</b> — создать резервную копию БД (для администраторов).\n"
        "🔸 <b>/wiki</b> — топ читаемых статей в Русской Википедии.",
        parse_mode=ParseMode.HTML
    ))


@dp.message(Command("addfeed"))
async def addfeed_handler(message: types.Message):
    if not is_admin(message.chat.id):
        await message.reply("⛔ Добавлять общие RSS-ленты могут только администраторы.")
        return

    args = (message.text or "").split(maxsplit=1)
    if len(args) < 2:
        await message.reply(
            "Укажите URL RSS-ленты. Пример:\n"
            "<code>/addfeed https://example.com/feed.rss</code>",
            parse_mode=ParseMode.HTML
        )
        return

    url = args[1].strip()
    await message.reply(f"🔍 <i>Проверяю RSS-ленту: {html_text(url)}</i>", parse_mode=ParseMode.HTML)

    # Валидируем URL и каждый редирект до передачи контента feedparser.
    try:
        feed_content = await asyncio.to_thread(fetch_public_feed, url, RSS_FETCH_TIMEOUT_SECONDS)
    except Exception as e:
        await message.reply(f"❌ Не удалось загрузить RSS-ленту: {html_text(e)}")
        return

    feed = await asyncio.to_thread(feedparser.parse, feed_content)
    if feed.bozo and not feed.entries:
        await message.reply(
            "❌ Не удалось прочитать RSS-ленту. Проверьте URL — это должна быть рабочая RSS/Atom ссылка."
        )
        return

    feed_title = cast(dict, feed.feed).get('title', url)

    # Читаем текущие категории из feeds.json
    with open(FEEDS_PATH, 'r', encoding='utf-8') as f:
        categories = json.load(f)

    # Проверяем, не добавлен ли уже этот URL
    for cat, urls in categories.items():
        if url in urls:
            await message.reply(f"ℹ️ Эта лента уже есть в категории <b>{html_text(cat)}</b>.", parse_mode=ParseMode.HTML)
            return

    # Сохраняем URL во временный словарь и показываем выбор категории
    pending_feeds[message.chat.id] = url

    markup = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=cat, callback_data=f"addfeed_cat|{i}")]
        for i, cat in enumerate(categories.keys())
    ])
    await message.reply(
        f"✅ Лента найдена: <b>{html_text(feed_title)}</b>\n"
        f"Записей в ленте: {len(feed.entries)}\n\n"
        "В какую категорию добавить?",
        parse_mode=ParseMode.HTML,
        reply_markup=markup
    )


@dp.callback_query(lambda c: c.data and c.data.startswith('addfeed_cat|'))
async def addfeed_cat_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    chat_id  = query_message.chat.id
    if not is_admin(chat_id):
        pending_feeds.pop(chat_id, None)
        await safe_answer_callback(callback_query, text="⛔ Недостаточно прав.", show_alert=True)
        return

    cat_idx  = int(callback_data(callback_query).split('|')[1])
    url      = pending_feeds.pop(chat_id, None)

    if not url:
        await safe_answer_callback(callback_query, text="⏰ Сессия истекла. Попробуйте /addfeed ещё раз.", show_alert=True)
        return

    with open(FEEDS_PATH, 'r', encoding='utf-8') as f:
        categories = json.load(f)

    cat_name = list(categories.keys())[cat_idx]
    categories[cat_name].append(url)

    with open(FEEDS_PATH, 'w', encoding='utf-8') as f:
        json.dump(categories, f, ensure_ascii=False, indent=4)

    await bot.edit_message_text(
        f"✅ Лента добавлена в категорию <b>{html_text(cat_name)}</b>!\n"
        f"<code>{html_text(url)}</code>\n\n"
        "Она появится в следующем дайджесте.",
        chat_id=chat_id,
        message_id=query_message.message_id,
        parse_mode=ParseMode.HTML
    )
    await safe_answer_callback(callback_query)
    logging.info(f"Added feed '{url}' to category '{cat_name}' by user {chat_id}")


@dp.message(Command("feedhealth"))
async def feedhealth_handler(message: types.Message):
    if not is_admin(message.chat.id):
        await message.reply("⛔ Проверять RSS-источники могут только администраторы.")
        return
    if not await enforce_rate_limit(message, "feedhealth", FEEDHEALTH_COOLDOWN_SECONDS):
        return

    status = await message.reply("⏳ <i>Проверяю RSS-источники...</i>", parse_mode=ParseMode.HTML)
    try:
        results = await asyncio.to_thread(rss_parser.check_all_sources, FEEDS_PATH)
    except Exception as e:
        await bot.edit_message_text(
            f"⚠️ Не удалось проверить RSS-источники: <code>{html_text(e)}</code>",
            chat_id=status.chat.id,
            message_id=status.message_id,
        )
        return

    try:
        await bot.delete_message(chat_id=status.chat.id, message_id=status.message_id)
    except Exception:
        pass
    failed_count = sum(1 for item in results if not item['ok'])
    if failed_count > FEEDHEALTH_PAGE_SIZE:
        feedhealth_sessions[message.chat.id] = {'results': results, 'page': 1}
    else:
        feedhealth_sessions.pop(message.chat.id, None)
    text, markup = render_feedhealth_page(results, 0)
    await message.reply(text, disable_web_page_preview=True, reply_markup=markup)


@dp.callback_query(lambda c: c.data == 'feedhealth_next')
async def feedhealth_next_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    chat_id = query_message.chat.id
    session = feedhealth_sessions.get(chat_id)
    if not session:
        await safe_answer_callback(callback_query, text="❌ Сессия истекла. Повторите /feedhealth.", show_alert=True)
        return

    page = session['page']
    results = session['results']
    text, markup = render_feedhealth_page(results, page)
    failed_count = sum(1 for item in results if not item['ok'])
    if (page + 1) * FEEDHEALTH_PAGE_SIZE < failed_count:
        session['page'] += 1
    else:
        feedhealth_sessions.pop(chat_id, None)

    await query_message.edit_text(text, disable_web_page_preview=True, reply_markup=markup)
    await safe_answer_callback(callback_query)


async def create_db_backup(reason: str = "scheduled"):
    logging.info(f"Creating DB backup: reason={reason}")
    backup_path = await asyncio.to_thread(
        create_backup,
        DB_PATH,
        BACKUP_DIR,
        BACKUP_RETENTION_COUNT,
    )
    logging.info(f"DB backup created: path={backup_path}")
    return backup_path


async def scheduled_db_backup():
    try:
        await create_db_backup(reason="scheduled")
    except Exception as e:
        logging.error(f"Scheduled DB backup failed: {e}")


@dp.message(Command("backup"))
async def backup_handler(message: types.Message):
    if not is_admin(message.chat.id):
        await message.reply("⛔ Создавать резервные копии могут только администраторы.")
        return
    if not await enforce_rate_limit(message, "backup", BACKUP_COOLDOWN_SECONDS):
        return

    status = await message.reply("⏳ <i>Создаю резервную копию базы...</i>", parse_mode=ParseMode.HTML)
    try:
        backup_path = await create_db_backup(reason=f"manual chat_id={message.chat.id}")
    except Exception as e:
        await bot.edit_message_text(
            f"⚠️ Не удалось создать backup: <code>{html_text(e)}</code>",
            chat_id=status.chat.id,
            message_id=status.message_id,
        )
        return

    await bot.edit_message_text(
        "✅ Backup создан.\n"
        f"<code>{html_text(os.path.basename(backup_path))}</code>",
        chat_id=status.chat.id,
        message_id=status.message_id,
        parse_mode=ParseMode.HTML,
    )
@dp.message(Command("stop"))
async def stop_handler(message: types.Message):
    """Спрашивает подтверждение перед отпиской."""
    markup = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="✅ Да, отписаться", callback_data="confirm_stop"),
        InlineKeyboardButton(text="❌ Нет, остаться", callback_data="cancel_stop"),
    ]])
    await message.reply(
        "⚠️ Вы уверены, что хотите отписаться от автоматического дайджеста?\n"
        "Отслеживаемые темы и настройки сохранятся.",
        reply_markup=markup
    )


@dp.callback_query(lambda c: c.data == "confirm_stop")
async def confirm_stop_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    chat_id = query_message.chat.id
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM subscribers WHERE chat_id = ?", (chat_id,))
        conn.commit()
        removed = cursor.rowcount

    text = (
        "✅ Вы отписались от автоматического дайджеста.\nЧтобы подписаться снова — /start"
        if removed else
        "ℹ️ Вы и так не были подписаны."
    )
    await bot.edit_message_text(text, chat_id=chat_id, message_id=query_message.message_id)
    await safe_answer_callback(callback_query)


@dp.callback_query(lambda c: c.data == "cancel_stop")
async def cancel_stop_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    await bot.edit_message_text(
        "👍 Отлично, вы остаётесь подписаны на дайджест.",
        chat_id=query_message.chat.id,
        message_id=query_message.message_id
    )
    await safe_answer_callback(callback_query)


@dp.message(Command("force"))
async def force_handler(message: types.Message):
    if not await enforce_rate_limit(message, "force", FORCE_COOLDOWN_SECONDS):
        return

    status = await message.reply(
        "⏳ <i>Запрашиваю Google Trends...</i>",
        parse_mode=ParseMode.HTML
    )
    await check_trends(force_send=True, force_chat_id=message.chat.id, status_msg=status)


@dp.message(Command("wiki"))
async def wiki_handler(message: types.Message):
    if not await enforce_rate_limit(message, "wiki", WIKI_COOLDOWN_SECONDS):
        return

    status = await message.reply("⏳ <i>Загружаю тренды Википедии за вчера...</i>", parse_mode=ParseMode.HTML)

    articles = await asyncio.to_thread(wiki_trends.fetch_wikipedia_trending, 'ru', 10)

    if not articles:
        await bot.edit_message_text(
            "⚠️ Не удалось получить данные Википедии.",
            chat_id=status.chat.id, message_id=status.message_id
        )
        return

    try:
        await bot.delete_message(chat_id=status.chat.id, message_id=status.message_id)
    except Exception:
        pass

    text = "📚 <b>Топ читаемых статей Русской Википедии за вчера</b>\n\n"
    for a in articles:
        views_str = f"{a['views']:,}".replace(',', ' ')
        text += f"{html_link(a['url'], a['title'])} — {views_str}\n"

    blocks = rm.build_blocks_wiki(articles, limit=10)
    await try_send_rich(message.chat.id, blocks, fallback_html=text)


@dp.message(Command("digest"))
async def digest_handler(message: types.Message):
    window_hours, error = parse_window_arg(message.text)
    if error:
        await message.reply(f"⚠️ {error}")
        return
    assert window_hours is not None
    if not await enforce_rate_limit(message, "digest", DIGEST_COOLDOWN_SECONDS):
        return

    status = await message.reply(
        f"⏳ <i>Запускаю сбор RSS-дайджеста за {format_window(window_hours)}...</i>",
        parse_mode=ParseMode.HTML
    )
    asyncio.create_task(send_digest(force_chat_id=message.chat.id, status_msg=status, window_hours=window_hours))


@dp.message(Command("bloggers"))
async def bloggers_handler(message: types.Message):
    window_hours, error = parse_window_arg(message.text)
    if error:
        await message.reply(f"⚠️ {error}")
        return
    assert window_hours is not None
    if not await enforce_rate_limit(message, "bloggers", DIGEST_COOLDOWN_SECONDS):
        return

    status = await message.reply(
        f"⏳ <i>Собираю статистику тем у блогеров за {format_window(window_hours)}...</i>",
        parse_mode=ParseMode.HTML
    )
    asyncio.create_task(send_video_stats(
        message.chat.id,
        status,
        BLOGGERS_PATH,
        "Блогеры: статистика тем",
        window_hours,
        include_single_topics=True,
        include_latest=False,
        require_repeated=False,
    ))


@dp.message(Command("fresh"))
async def fresh_handler(message: types.Message):
    window_hours, error = parse_window_arg(message.text)
    if error:
        await message.reply(f"⚠️ {error}")
        return
    assert window_hours is not None
    if not await enforce_rate_limit(message, "fresh", DIGEST_COOLDOWN_SECONDS):
        return

    status = await message.reply(
        f"⏳ <i>Ищу новое за {format_window(window_hours)}, чего ещё не было во fresh-дайджестах...</i>",
        parse_mode=ParseMode.HTML
    )
    asyncio.create_task(send_digest(force_chat_id=message.chat.id, status_msg=status, fresh_only=True, window_hours=window_hours))


@dp.message(Command("search"))
async def search_handler(message: types.Message):
    args = (message.text or "").split(maxsplit=1)
    if len(args) < 2:
        await message.reply(
            "Пожалуйста, укажите запрос. Пример: <code>/search apple</code>",
            parse_mode=ParseMode.HTML,
        )
        return

    if not await enforce_rate_limit(message, "search", SEARCH_COOLDOWN_SECONDS):
        return

    query = args[1]
    await message.reply(f"🔍 <i>Ищу «{html_text(query)}» во всех источниках...</i>", parse_mode=ParseMode.HTML)

    enabled_categories = get_enabled_categories(message.chat.id)

    # Параллельно ищем в RSS и SearXNG. Если один источник зависает, показываем частичный результат.
    logging.info(f"Search started: chat_id={message.chat.id}, query={query!r}")
    tasks = {
        "rss": asyncio.create_task(asyncio.to_thread(
            rss_parser.search_feeds,
            query,
            FEEDS_PATH,
            SEARCH_WINDOW_HRS,
            enabled_categories,
        )),
        "searx": asyncio.create_task(asyncio.to_thread(
            searxng_client.search, query, 'news', 'ru-RU', 10, 'day', SEARCH_WINDOW_HRS
        )),
    }
    done, pending = await asyncio.wait(tasks.values(), timeout=SEARCH_TIMEOUT_SECONDS)
    for task in pending:
        task.cancel()

    rss_raw: list[dict] = []
    searx_raw: list[dict] = []
    failed_sources: list[str] = []
    timed_out_sources = [name for name, task in tasks.items() if task in pending]
    for name, task in tasks.items():
        if task not in done:
            continue
        try:
            if name == "rss":
                rss_raw = task.result()
            else:
                searx_raw = task.result()
        except Exception as e:
            failed_sources.append(name)
            logging.exception(f"Search source failed: chat_id={message.chat.id}, query={query!r}, source={name}, error={e}")

    if not done:
        await message.reply(
            f"⚠️ Поиск по «{html_text(query)}» занял больше {SEARCH_TIMEOUT_SECONDS} секунд. "
            "Источники не успели ответить.",
            parse_mode=ParseMode.HTML,
        )
        return

    logging.info(
        f"Search finished: chat_id={message.chat.id}, query={query!r}, "
        f"rss={len(rss_raw)}, searx={len(searx_raw)}, timeout={timed_out_sources}, failed={failed_sources}"
    )

    results = merge_search_results(rss_raw, searx_raw)
    partial_messages = []
    if timed_out_sources:
        partial_messages.append("часть источников не успела ответить")
    if failed_sources:
        partial_messages.append("часть источников вернула ошибку")
    partial_notice = "; ".join(partial_messages)

    if not results:
        markup = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="🔔 Уведомить, когда появится", callback_data=safe_cb("track", query))
        ]])
        await message.reply(
            f"😔 По запросу «{html_text(query)}» ничего не найдено.\n"
            "Хотите, чтобы я уведомил вас, когда появятся новости?",
            reply_markup=markup
        )
        return

    remaining = len(results) - SEARCH_PAGE_SIZE
    if remaining > 0:
        search_sessions[message.chat.id] = {'results': results, 'query': query, 'page': 1, 'partial_notice': partial_notice}
    else:
        search_sessions.pop(message.chat.id, None)
    text, markup = render_search_page(query, results, 0, partial_notice)

    await message.reply(text, disable_web_page_preview=True, reply_markup=markup)


@dp.callback_query(lambda c: c.data == 'search_next')
async def search_next_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    chat_id = query_message.chat.id
    session = search_sessions.get(chat_id)
    if not session:
        await safe_answer_callback(callback_query, text="❌ Сессия истекла. Повторите поиск.", show_alert=True)
        return

    page     = session['page']
    results  = session['results']
    query    = session['query']
    partial_notice = session.get('partial_notice', '')
    text, markup = render_search_page(query, results, page, partial_notice)
    remaining = len(results) - ((page + 1) * SEARCH_PAGE_SIZE)
    if remaining > 0:
        session['page'] += 1
    else:
        search_sessions.pop(chat_id, None)

    await query_message.edit_text(text, disable_web_page_preview=True, reply_markup=markup)
    await safe_answer_callback(callback_query)



@dp.callback_query(lambda c: c.data and c.data.startswith('track|'))
async def process_track_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    topic   = callback_data(callback_query).split('|')[1]
    chat_id = query_message.chat.id

    already_tracked = False
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                "INSERT INTO tracked_topics (chat_id, topic, last_checked) VALUES (?, ?, ?)",
                (chat_id, topic, time.time())
            )
            conn.commit()
    except sqlite3.IntegrityError:
        already_tracked = True

    await safe_answer_callback(callback_query)  # закрываем спиннер без popup

    # Отправляем подтверждение и удаляем через 60 сек
    try:
        if already_tracked:
            confirm_text = f"ℹ️ Уже слежу за <b>{html_text(topic)}</b>"
        else:
            confirm_text = f"🔔 Слежу за <b>{html_text(topic)}</b>\nПришлю уведомление, как появятся новости."
        confirm = await bot.send_message(
            chat_id, confirm_text, parse_mode=ParseMode.HTML
        )
        asyncio.create_task(schedule_delete(chat_id, confirm.message_id, delay=60.0))
    except Exception as e:
        logging.warning(f"Failed to send track confirmation: {e}")

    # Replace the track button with a check mark after tracking.
    try:
        current = query_message.reply_markup
        if current:
            new_rows = [
                [
                    InlineKeyboardButton(
                        text=chr(0x2705) if btn.callback_data == callback_query.data else btn.text,
                        callback_data=btn.callback_data
                    )
                    for btn in row
                ]
                for row in current.inline_keyboard
            ]
            await query_message.edit_reply_markup(
                reply_markup=InlineKeyboardMarkup(inline_keyboard=new_rows)
            )
    except Exception:
        pass


@dp.callback_query(lambda c: c.data and c.data.startswith('ignore|'))
async def process_ignore_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    topic   = callback_data(callback_query).split('|')[1]
    chat_id = query_message.chat.id

    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("INSERT INTO blocked_topics (chat_id, topic) VALUES (?, ?)", (chat_id, topic))
            conn.commit()
    except sqlite3.IntegrityError:
        pass

    await safe_answer_callback(callback_query)  # закрываем спиннер
    # Удаляем исходное сообщение сразу (скрытая тема — сообщение больше не нужно)
    try:
        await bot.delete_message(
            chat_id=query_message.chat.id,
            message_id=query_message.message_id
        )
    except Exception:
        pass


@dp.message(Command("follow"))
async def follow_handler(message: types.Message):
    """Подписка на тему напрямую: /follow <тема>."""
    args = (message.text or "").split(maxsplit=1)
    if len(args) < 2 or not args[1].strip():
        await message.reply(
            "Укажите тему для отслеживания. Пример:\n"
            "<code>/follow ChatGPT обновление</code>",
            parse_mode=ParseMode.HTML,
        )
        return

    topic = args[1].strip()
    chat_id = message.chat.id
    already_tracked = False
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                "INSERT INTO tracked_topics (chat_id, topic, last_checked) VALUES (?, ?, ?)",
                (chat_id, topic, time.time()),
            )
            conn.commit()
    except sqlite3.IntegrityError:
        already_tracked = True

    if already_tracked:
        text = f"ℹ️ Уже слежу за <b>{html_text(topic)}</b>"
    else:
        text = (
            f"🔔 Слежу за <b>{html_text(topic)}</b>\n"
            "Пришлю уведомление, как появятся новости."
        )
    confirm = await message.reply(text, parse_mode=ParseMode.HTML)
    asyncio.create_task(schedule_delete(chat_id, confirm.message_id, delay=60.0))


@dp.message(Command("subs"))
async def subs_handler(message: types.Message):
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, topic FROM tracked_topics WHERE chat_id = ?", (message.chat.id,))
        topics = cursor.fetchall()

    if not topics:
        await message.reply("🔔 Вы пока не следите ни за одной темой.")
        return

    await message.reply(
        "🔔 <b>Ваши отслеживаемые темы:</b>\nНажмите ❌, чтобы отписаться.",
        parse_mode=ParseMode.HTML,
        reply_markup=make_subs_markup(topics)
    )


@dp.callback_query(lambda c: c.data and c.data.startswith('unfollow|'))
async def process_unfollow_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    track_id = int(callback_data(callback_query).split('|')[1])
    chat_id  = query_message.chat.id

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM tracked_topics WHERE id = ? AND chat_id = ?", (track_id, chat_id))
        conn.commit()

    await safe_answer_callback(callback_query, text="Вы отписались от темы.", show_alert=True)

    # Обновляем кнопки в том же сообщении
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, topic FROM tracked_topics WHERE chat_id = ?", (chat_id,))
        remaining = cursor.fetchall()

    if remaining:
        await bot.edit_message_reply_markup(
            chat_id=chat_id,
            message_id=query_message.message_id,
            reply_markup=make_subs_markup(remaining)
        )
    else:
        await bot.edit_message_text(
            "🔔 Список отслеживаемых тем пуст.",
            chat_id=chat_id,
            message_id=query_message.message_id
        )


@dp.message(Command("ignored"))
async def ignored_handler(message: types.Message):
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, topic FROM blocked_topics WHERE chat_id = ?", (message.chat.id,))
        topics = cursor.fetchall()

    if not topics:
        await message.reply("✅ У вас нет скрытых тем.")
        return

    await message.reply(
        "🙈 <b>Скрытые темы:</b>\nНажмите 👁, чтобы разблокировать.",
        parse_mode=ParseMode.HTML,
        reply_markup=make_ignored_markup(topics)
        )


@dp.message(Command("sources"))
async def sources_handler(message: types.Message):
    await message.reply(
        "🧭 <b>Категории RSS-источников</b>\nНажмите, чтобы включить или отключить категорию.",
        parse_mode=ParseMode.HTML,
        reply_markup=make_sources_markup(message.chat.id),
    )


@dp.callback_query(lambda c: c.data and c.data.startswith('source|'))
async def source_toggle_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    chat_id = query_message.chat.id
    category = callback_data(callback_query).split('|', 1)[1]
    categories = load_feed_categories()
    if category not in categories:
        await safe_answer_callback(callback_query, text="Категория устарела. Откройте /sources заново.", show_alert=True)
        return

    enabled = get_enabled_categories(chat_id)
    currently_enabled = category in enabled
    if currently_enabled and len(enabled) <= 1:
        await safe_answer_callback(callback_query, text="Нельзя отключить последнюю категорию.", show_alert=True)
        return

    new_enabled = 0 if currently_enabled else 1
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO user_source_preferences (chat_id, category, enabled, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(chat_id, category)
            DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP
            """,
            (chat_id, category, new_enabled),
        )
        conn.commit()

    await query_message.edit_reply_markup(reply_markup=make_sources_markup(chat_id))
    await safe_answer_callback(callback_query, text="Настройки источников обновлены.")


@dp.callback_query(lambda c: c.data == 'sources_close')
async def sources_close_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    chat_id = query_message.chat.id
    message_id = query_message.message_id
    try:
        await bot.delete_message(chat_id=chat_id, message_id=message_id)
    except TelegramBadRequest:
        await bot.edit_message_text(
            "Настройки источников закрыты.",
            chat_id=chat_id,
            message_id=message_id,
        )
    await safe_answer_callback(callback_query)


@dp.callback_query(lambda c: c.data and c.data.startswith('unblock|'))
async def process_unblock_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    block_id = int(callback_data(callback_query).split('|')[1])
    chat_id  = query_message.chat.id

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM blocked_topics WHERE id = ? AND chat_id = ?", (block_id, chat_id))
        conn.commit()

    await safe_answer_callback(callback_query, text="✅ Тема разблокирована.", show_alert=True)

    # Обновляем кнопки в том же сообщении
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, topic FROM blocked_topics WHERE chat_id = ?", (chat_id,))
        remaining = cursor.fetchall()

    if remaining:
        await bot.edit_message_reply_markup(
            chat_id=chat_id,
            message_id=query_message.message_id,
            reply_markup=make_ignored_markup(remaining)
        )
    else:
        await bot.edit_message_text(
            "✅ Список скрытых тем пуст.",
            chat_id=chat_id,
            message_id=query_message.message_id
        )


# ── Scheduled tasks ────────────────────────────────────────────────────────────
async def check_tracked_topics():
    logging.info("Checking tracked topics (Watchdog)...")

    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, chat_id, topic, last_checked FROM tracked_topics")
        tracked = cursor.fetchall()

    if not tracked:
        return

    try:
        items = await asyncio.to_thread(rss_parser.fetch_all_items, time_window_hours=WATCHDOG_WINDOW_HRS)
    except Exception as e:
        logging.error(f"RSS fetch error in watchdog: {e}")
        return

    now     = time.time()
    updates = []

    for track_id, chat_id, topic, last_checked in tracked:
        try:
            last_checked_ts = float(last_checked)
        except (TypeError, ValueError):
            last_checked_ts = now - WATCHDOG_WINDOW_HRS * 3600

        # Извлекаем ключевые слова для внешнего поиска.
        keywords = searxng_client.extract_keywords(topic)

        def matches(title: str) -> bool:
            return tracked_topic_matches(title, topic)

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT url FROM sent_articles WHERE chat_id = ?", (chat_id,))
            sent_urls = {normalize_article_url(row[0]) for row in cursor.fetchall()}
        enabled_categories = get_enabled_categories(chat_id)

        # 1. Поиск в RSS
        rss_matches = [
            item for item in items
            if normalize_article_url(item.get('link', '')) not in sent_urls
            and item.get('category') in enabled_categories
            and item['time'] > last_checked_ts
            and matches(item['title'])
        ]

        # 2. Поиск в SearXNG (если есть ключевые слова)
        sx_results: list[dict] = []
        if keywords:
            sx_query  = searxng_client.build_query(topic)
            sx_raw    = await asyncio.to_thread(
                searxng_client.search, sx_query, 'news', 'ru-RU', 10, 'day', WATCHDOG_WINDOW_HRS
            )
            sx_results = [
                r for r in sx_raw
                if normalize_article_url(r['url']) not in sent_urls
                and (r.get('published_ts') or 0) > last_checked_ts
                and matches(r['title'])
            ]

        all_new = rss_matches + [
            {'title': r['title'], 'link': r['url'], 'source_name': r['source'], 'time': r.get('published_ts') or now}
            for r in sx_results
        ]

        if not all_new:
            continue

        # Дедупликация по URL
        seen: set[str] = set()
        unique_new: list[dict] = []
        for item in all_new:
            url_key = normalize_article_url(item.get('link', ''))
            if url_key and url_key not in sent_urls and url_key not in seen:
                seen.add(url_key)
                unique_new.append(item)

        if not unique_new:
            continue

        unique_new.sort(key=radar_sort_key)
        claimed: list[tuple[str, dict]] = []
        with sqlite3.connect(DB_PATH) as conn:
            for item in unique_new:
                if len(claimed) >= 8:
                    break
                url_key = normalize_article_url(item.get('link', ''))
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO sent_articles (chat_id, url) VALUES (?, ?)",
                    (chat_id, url_key)
                )
                if cursor.rowcount:
                    claimed.append((url_key, item))
            conn.commit()

        if not claimed:
            continue

        text = f"🔔 <b>{html_text(topic)}</b>\n\n"
        for _, item in claimed:
            src = item.get('source_name', '')
            text += f"🔹 {html_link(item['link'], item['title'])} {html_text(src)}\n"

        try:
            await send_long_message(chat_id, text, disable_web_page_preview=True)
            updates.append((now, track_id))
        except Exception as e:
            with sqlite3.connect(DB_PATH) as conn:
                conn.executemany(
                    "DELETE FROM sent_articles WHERE chat_id = ? AND url = ?",
                    [(chat_id, url_key) for url_key, _ in claimed]
                )
                conn.commit()
            logging.error(f"Failed alert to {chat_id}: {e}")

    if updates:
        with sqlite3.connect(DB_PATH) as conn:
            conn.executemany("UPDATE tracked_topics SET last_checked = ? WHERE id = ?", updates)
            conn.commit()


async def send_digest(force_chat_id: int | None = None, status_msg=None, fresh_only: bool = False, window_hours: int = DIGEST_WINDOW_HRS):
    logging.info("Generating RSS Digest...")

    async def upd(text: str):
        """Edited status message if available."""
        if status_msg:
            try:
                await bot.edit_message_text(
                    text, chat_id=status_msg.chat.id,
                    message_id=status_msg.message_id, parse_mode=ParseMode.HTML
                )
            except Exception:
                pass

    mode_label = "fresh-дайджест" if fresh_only else "RSS-дайджест"
    await upd(f"⏳ <i>Загружаю {mode_label} за {format_window(window_hours)}... Это займёт 15–30 секунд.</i>")

    try:
        digest = await asyncio.to_thread(
            rss_parser.fetch_category_digest,
            time_window_hours=window_hours,
            archive_db_path=DB_PATH,
        )
    except Exception as e:
        logging.error(f"RSS digest fetch error: {e}")
        await upd(f"⚠️ Не удалось получить дайджест: <code>{html_text(e)}</code>")
        if force_chat_id and not status_msg:
            await bot.send_message(force_chat_id, "⚠️ Не удалось получить данные для дайджеста. Попробуйте позже.")
        return

    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT chat_id FROM subscribers")
        subscribers = [row[0] for row in cursor.fetchall()]

    if not subscribers and not force_chat_id:
        return

    target_chats = [force_chat_id] if force_chat_id else subscribers
    sent_any = {chat_id: False for chat_id in target_chats}

    if not digest:
        await upd("ℹ️ Нет пересечений в новостях для дайджеста.")
        if not status_msg:
            for chat_id in target_chats:
                await bot.send_message(chat_id, "ℹ️ На данный момент нет явных пересечений в новостях для дайджеста.")
    else:
        total_cats   = len(digest)
        total_topics = sum(len(v) for v in digest.values())

        cat_emojis = {
            "Технологии и Игры":   "🕹",
            "Экономика и Бизнес":  "📈",
            "Медиа и Развлечения": "🍿",
            "Мировые Новости":     "🌍",
            "Политика и Иное":     "🏛",
        }

        for cat_idx, (cat_name, topics) in enumerate(digest.items(), 1):
            emoji = cat_emojis.get(cat_name, "📰")
            await upd(
                f"⏳ <b>Дайджест</b> — отправляю категории...\n"
                f"{emoji} {html_text(cat_name)} ({cat_idx}/{total_cats})\n"
                f"📊 Найдено {total_topics} тем во всех категориях"
            )

            for chat_id in target_chats:
                if cat_name not in get_enabled_categories(chat_id):
                    continue
                excluded = get_user_excluded(chat_id)
                filtered = [t for t in topics if not is_blocked(t['main_title'], excluded)]
                if fresh_only:
                    filtered = filter_digest_topics_for_fresh(filtered, get_digest_seen_urls(chat_id))
                if not filtered:
                    continue

                # Заголовок категории
                try:
                    await bot.send_message(
                        chat_id,
                        f"{emoji} <b>Дайджест: {html_text(cat_name)}</b>",
                        disable_web_page_preview=True
                    )
                except Exception as e:
                    logging.error(f"Failed to send category header to {chat_id}: {e}")

                # Каждая тема — отдельным сообщением с кнопками
                for t in filtered:
                    items = t['items'][:5]
                    multi = len(items) > 1

                    if multi:
                        # Несколько источников: короткая шапка из ключевых слов
                        kws = searxng_client.extract_keywords(t['main_title'])
                        short_topic = ' · '.join(kws[:4]) if kws else t['main_title'][:60]
                        topic_text = f"📌 <b>{html_text(short_topic)}</b>\n"
                        for item in items:
                            src = item.get('source_name', '')
                            views = item.get('views', '')
                            views_str = f" — {views} пр." if views else ''
                            topic_text += f"🔗 {html_link(item['link'], item['title'])} {html_text(src)}{html_text(views_str)}\n"
                    else:
                        # Один источник: просто ссылка, без повтора заголовка
                        item = items[0]
                        src = item.get('source_name', '')
                        views = item.get('views', '')
                        views_str = f" — {views} пр." if views else ''
                        topic_text = f"🔗 {html_link(item['link'], item['title'])} {html_text(src)}{html_text(views_str)}\n"

                    markup = InlineKeyboardMarkup(inline_keyboard=[[
                        InlineKeyboardButton(text="🔔", callback_data=safe_cb("track", t['main_title'])),
                        InlineKeyboardButton(text="🙈", callback_data=safe_cb("ignore", t['main_title']))
                    ]])
                    try:
                        blocks = rm.build_blocks_rss_topic(t)
                        await try_send_rich(
                            chat_id, blocks,
                            fallback_html=topic_text,
                            reply_markup=markup
                        )
                        sent_any[chat_id] = True
                        if fresh_only:
                            mark_digest_seen(chat_id, collect_topic_urls(t))
                    except Exception as e:
                        logging.error(f"Failed to send digest topic to {chat_id}: {e}")
                    await asyncio.sleep(0.4)

            await asyncio.sleep(1)

    if not fresh_only:
        await upd("⏳ <b>Дайджест</b> — собираю Google Trends и Википедию...")
        try:
            google_trends = await asyncio.to_thread(trends_parser.fetch_google_trends, geo="RU")
        except Exception as e:
            logging.error(f"Google Trends digest fetch error: {e}")
            google_trends = []

        hot_google_trends = [
            trend for trend in google_trends
            if trends_parser.parse_traffic_value(trend.get("traffic", "")) > GOOGLE_DIGEST_MIN_TRAFFIC
        ][:GOOGLE_DIGEST_LIMIT]

        try:
            wiki_articles = await asyncio.to_thread(
                wiki_trends.fetch_wikipedia_trending,
                'ru',
                WIKI_DIGEST_LIMIT * 2,
            )
        except Exception as e:
            logging.error(f"Wikipedia digest fetch error: {e}")
            wiki_articles = []

        hot_wiki_articles = [
            article for article in wiki_articles
            if article.get("views", 0) > WIKI_DIGEST_MIN_VIEWS
        ][:WIKI_DIGEST_LIMIT]

        for chat_id in target_chats:
            excluded = get_user_excluded(chat_id)
            chat_google_trends = [
                trend for trend in hot_google_trends
                if not is_blocked(trend["title"], excluded)
            ]
            if chat_google_trends:
                try:
                    blocks = rm.build_blocks_google_trends(
                        chat_google_trends, GOOGLE_DIGEST_MIN_TRAFFIC, GOOGLE_DIGEST_LIMIT
                    )
                    await try_send_rich(
                        chat_id, blocks,
                        fallback_html=render_google_trends_digest(chat_google_trends),
                    )
                    sent_any[chat_id] = True
                except Exception as e:
                    logging.error(f"Failed to send Google Trends digest to {chat_id}: {e}")

            chat_wiki_articles = [
                article for article in hot_wiki_articles
                if not is_blocked(article["title"], excluded)
            ]
            if chat_wiki_articles:
                try:
                    blocks = rm.build_blocks_wiki(chat_wiki_articles, WIKI_DIGEST_LIMIT)
                    await try_send_rich(
                        chat_id, blocks,
                        fallback_html=render_wiki_digest(chat_wiki_articles),
                    )
                    sent_any[chat_id] = True
                except Exception as e:
                    logging.error(f"Failed to send Wikipedia digest to {chat_id}: {e}")

    async def send_video_digest_block(
        file_path: str,
        status_text: str,
        title: str,
        include_latest: bool,
        include_single_topics: bool,
        require_repeated: bool,
        log_label: str,
    ) -> None:
        if not os.path.exists(file_path):
            return
        await upd(status_text)
        try:
            video_digest = await asyncio.to_thread(
                blogger_digest.build_blogger_digest,
                file_path,
                window_hours,
            )
        except Exception as e:
            logging.error(f"{log_label} digest fetch error: {e}")
            video_digest = None

        if video_digest and video_digest.get("videos"):
            for chat_id in target_chats:
                digest_for_chat = video_digest
                if fresh_only:
                    digest_for_chat = filter_blogger_digest_for_fresh(
                        video_digest,
                        get_digest_seen_urls(chat_id),
                    )
                if not digest_for_chat.get("videos"):
                    continue
                repeated_topics = digest_for_chat.get("repeated_topics") or digest_for_chat.get("repeated")
                if require_repeated and not repeated_topics:
                    continue
                full_title = f"{title} за {format_window(window_hours)}"
                text = render_blogger_digest(
                    digest_for_chat,
                    title=full_title,
                    include_latest=include_latest,
                    include_single_topics=include_single_topics,
                )
                blocks = rm.build_blocks_blogger(
                    digest_for_chat,
                    title=full_title,
                    repeated_limit=BLOGGER_REPEATED_TOPIC_LIMIT,
                    examples_per_topic=BLOGGER_EXAMPLES_PER_TOPIC,
                    snippet_chars=BLOGGER_SNIPPET_CHARS,
                    chapters_per_example=BLOGGER_CHAPTERS_PER_EXAMPLE,
                    latest_limit=BLOGGER_LATEST_LIMIT,
                    include_latest=include_latest,
                    include_single_topics=include_single_topics,
                    single_topic_limit=BLOGGER_SINGLE_TOPIC_LIMIT,
                )
                try:
                    await try_send_rich(chat_id, blocks, fallback_html=text)
                    sent_any[chat_id] = True
                    if fresh_only:
                        mark_digest_seen(chat_id, collect_blogger_urls(digest_for_chat))
                except Exception as e:
                    logging.error(f"Failed to send {log_label} digest to {chat_id}: {e}")

    await send_video_digest_block(
        BLOGGERS_PATH,
        "⏳ <b>Дайджест</b> — собираю блок блогеров...",
        "Блогеры и YouTube-каналы",
        include_latest=False,
        include_single_topics=True,
        require_repeated=False,
        log_label="Blogger",
    )
    await send_video_digest_block(
        NEWS_CHANNELS_PATH,
        "⏳ <b>Дайджест</b> — собираю блок новостных каналов...",
        "Новостные YouTube-каналы",
        include_latest=False,
        include_single_topics=False,
        require_repeated=True,
        log_label="News channel",
    )

    if fresh_only:
        for chat_id, was_sent in sent_any.items():
            if not was_sent:
                try:
                    await bot.send_message(chat_id, "ℹ️ Нового с прошлого fresh-дайджеста нет.")
                except Exception as e:
                    logging.error(f"Failed to send empty fresh digest notice to {chat_id}: {e}")

    # Удаляем статусное сообщение, чтобы не мусорить чат
    if status_msg:
        try:
            await bot.delete_message(chat_id=status_msg.chat.id, message_id=status_msg.message_id)
        except Exception:
            pass


async def check_trends(force_send: bool = False, force_chat_id: int | None = None, status_msg=None):
    logging.info("Checking for new trends...")

    async def upd(text: str):
        if status_msg:
            try:
                await bot.edit_message_text(
                    text, chat_id=status_msg.chat.id,
                    message_id=status_msg.message_id, parse_mode=ParseMode.HTML
                )
            except Exception:
                pass

    await upd("⏳ <i>Запрашиваю Google Trends...</i>")

    try:
        trends = await asyncio.to_thread(trends_parser.fetch_google_trends, geo="RU")
    except Exception as e:
        logging.error(f"Google Trends fetch error: {e}")
        await upd(f"⚠️ Не удалось получить тренды: <code>{html_text(e)}</code>")
        if force_chat_id and not status_msg:
            await bot.send_message(force_chat_id, "⚠️ Не удалось получить тренды. Попробуйте позже.")
        return

    if not trends:
        logging.warning("Google Trends returned empty list.")
        await upd("ℹ️ Google Trends не вернул данных.")
        if force_chat_id and not status_msg:
            await bot.send_message(force_chat_id, "ℹ️ Google Trends не вернул данных.")
        return

    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT chat_id FROM subscribers")
        subscribers = [row[0] for row in cursor.fetchall()]

    if not subscribers and not force_chat_id:
        logging.info("No subscribers yet. Skipping broadcasting.")
        return

    if force_send:
        assert force_chat_id is not None
        # При /force — перебираем все тренды, пропуская заблокированные и уже отслеживаемые
        target_chat = force_chat_id  # /force всегда один пользователь
        excluded = get_user_excluded(target_chat)
        trends_to_send = []
        for t in trends:
            if len(trends_to_send) >= FORCE_TRENDS_LIMIT:
                break
            if not is_blocked(t['title'], excluded):
                trends_to_send.append(t)

        if not trends_to_send:
            await upd("ℹ️ Все текущие тренды уже в вашем списке или скрыты. Google Trends обновляется раз в час — попробуйте позже.")
            return

        await upd(
            f"📊 Найдено <b>{len(trends)}</b> трендов, подходящих: <b>{len(trends_to_send)}</b>\n"
            f"⏳ Отправляю..."
        )
    else:
        # Плановая рассылка — только новые тренды
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM sent_trends")
            is_first_run = cursor.fetchone()[0] == 0

            trends_to_send = []
            for t in trends:
                cursor.execute("SELECT id FROM sent_trends WHERE id = ?", (t['id'],))
                if not cursor.fetchone():
                    if is_first_run:
                        cursor.execute("INSERT INTO sent_trends (id) VALUES (?)", (t['id'],))
                        if len(trends_to_send) < 1:
                            trends_to_send.append(t)
                    else:
                        trends_to_send.append(t)
                        cursor.execute("INSERT INTO sent_trends (id) VALUES (?)", (t['id'],))
            conn.commit()

    target_chats = [force_chat_id] if force_chat_id else subscribers

    for t in trends_to_send:
        text = f"<b>🔥 {html_text(t['title'])}</b>\n\n"
        if t.get('traffic'):
            text += f"🔎 <i>Более {html_text(t['traffic'])} запросов</i>\n\n"
        if t.get('news'):
            text += "📰 <b>К теме:</b>\n"
            for n in t['news'][:3]:
                text += f"🔹 {html_link(n['url'], n['title'])}\n"

        markup = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="🔔", callback_data=safe_cb("track", t['title'])),
            InlineKeyboardButton(text="🙈", callback_data=safe_cb("ignore", t['title']))
        ]])

        for chat_id in target_chats:
            excluded = get_user_excluded(chat_id)
            if is_blocked(t['title'], excluded):
                logging.info(f"Skipping excluded topic '{t['title']}' for {chat_id}")
                continue
            try:
                if t.get('picture'):
                    await bot.send_photo(chat_id, URLInputFile(t['picture']), caption=text, reply_markup=markup)
                else:
                    await bot.send_message(chat_id, text, reply_markup=markup)
            except Exception as e:
                logging.error(f"Failed to send to {chat_id}: {e}")

        await asyncio.sleep(2)

    # Удаляем статусное сообщение чтобы не мусорить чат
    if force_send and status_msg:
        try:
            await bot.delete_message(chat_id=status_msg.chat.id, message_id=status_msg.message_id)
        except Exception:
            pass


# ── Stale subscription check ────────────────────────────────────────────────────────
async def check_stale_topics():
    """Daily: если по теме не было новостей STALE_DAYS дней — спрашиваем пользователя."""
    logging.info("Checking stale tracked topics...")
    stale_threshold = time.time() - STALE_DAYS * 86400

    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        # Темы, где last_checked старше STALE_DAYS дней
        # И либо не спрашивали раньше, либо спрашивали ещё до прошлого алерта
        cursor.execute("""
            SELECT id, chat_id, topic FROM tracked_topics
            WHERE CAST(last_checked AS REAL) < ?
            AND (stale_asked_at IS NULL OR CAST(stale_asked_at AS REAL) < CAST(last_checked AS REAL))
        """, (stale_threshold,))
        stale = cursor.fetchall()

    for track_id, chat_id, topic in stale:
        markup = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="✅ Оставить",  callback_data=f"stale_keep|{track_id}"),
            InlineKeyboardButton(text="🗑 Удалить", callback_data=f"stale_del|{track_id}")
        ]])
        try:
            await bot.send_message(
                chat_id,
                f"⏰ Вы всё ещё следите за «<b>{html_text(topic)}</b>»?\n"
                f"Новостей по этой теме не было <b>{STALE_DAYS} дней</b>.",
                reply_markup=markup
            )
            # Фиксируем что спросили
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute(
                    "UPDATE tracked_topics SET stale_asked_at = ? WHERE id = ?",
                    (time.time(), track_id)
                )
                conn.commit()
        except Exception as e:
            logging.error(f"Failed stale check message to {chat_id}: {e}")


@dp.callback_query(lambda c: c.data and c.data.startswith('stale_keep|'))
async def stale_keep_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    track_id = int(callback_data(callback_query).split('|')[1])
    with sqlite3.connect(DB_PATH) as conn:
        # Сбрасываем таймер — пользователь хочет продолжать следить
        conn.execute(
            "UPDATE tracked_topics SET last_checked = ?, stale_asked_at = NULL WHERE id = ?",
            (time.time(), track_id)
        )
        conn.commit()
    try:
        await bot.delete_message(
            chat_id=query_message.chat.id,
            message_id=query_message.message_id
        )
    except Exception:
        pass
    await safe_answer_callback(callback_query, text="✅ Ок, продолжаю следить!")


@dp.callback_query(lambda c: c.data and c.data.startswith('stale_del|'))
async def stale_del_callback(callback_query: types.CallbackQuery):
    query_message = callback_message(callback_query)
    track_id = int(callback_data(callback_query).split('|')[1])
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT topic FROM tracked_topics WHERE id = ?", (track_id,))
        row = cursor.fetchone()
        topic = row[0] if row else 'тема'
        conn.execute("DELETE FROM tracked_topics WHERE id = ?", (track_id,))
        conn.commit()
    try:
        await bot.delete_message(
            chat_id=query_message.chat.id,
            message_id=query_message.message_id
        )
    except Exception:
        pass
    await safe_answer_callback(callback_query, text=f"🗑 «{topic}» удалена из подписок.")


# ── Entry point ────────────────────────────────────────────────────────────────
async def main():
    scheduler = AsyncIOScheduler()
    scheduler.add_job(send_digest,          'interval', hours=DIGEST_INTERVAL_HOURS,  max_instances=1)
    scheduler.add_job(check_tracked_topics, 'interval', hours=WATCHDOG_INTERVAL_HRS,  max_instances=1)
    scheduler.add_job(check_stale_topics,   'interval', hours=24,                     max_instances=1)
    scheduler.add_job(scheduled_db_backup,  'interval', hours=BACKUP_INTERVAL_HOURS,  max_instances=1)
    scheduler.start()

    try:
        while True:
            try:
                await dp.start_polling(bot)
                break
            except TelegramNetworkError as e:
                logging.warning(f"Telegram polling failed, retrying in 15s: {e}")
                await asyncio.sleep(15)
    finally:
        scheduler.shutdown(wait=False)
        await bot.session.close()
        logging.info("Bot stopped gracefully.")


if __name__ == "__main__":
    asyncio.run(main())

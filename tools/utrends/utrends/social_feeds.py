import os


def _split_csv(value: str) -> list[str]:
    return [part.strip().strip("@") for part in value.split(",") if part.strip()]


def build_rsshub_social_feeds(base_url: str | None = None, env=os.environ) -> list[str]:
    """Build optional RSSHub routes for VK, OK, and X/Twitter."""
    base = (base_url or env.get("RSSHUB_BASE_URL", "")).strip().rstrip("/")
    if not base:
        return []

    feeds: list[str] = []
    for handle in _split_csv(env.get("RSSHUB_VK_USERS", "")):
        feeds.append(f"{base}/vk/user/{handle}")
    for group in _split_csv(env.get("RSSHUB_VK_GROUPS", "")):
        feeds.append(f"{base}/vk/group/{group}")
    for group in _split_csv(env.get("RSSHUB_OK_GROUPS", "")):
        feeds.append(f"{base}/ok/group/{group}")
    for handle in _split_csv(env.get("RSSHUB_X_USERS", "")):
        feeds.append(f"{base}/twitter/user/{handle}")
    return feeds

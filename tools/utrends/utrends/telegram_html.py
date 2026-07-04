import html


def html_text(value) -> str:
    """Escape untrusted text before inserting it into Telegram HTML."""
    return html.escape(str(value), quote=True)


def html_link(url, label) -> str:
    """Render a Telegram HTML link with escaped URL and label."""
    return f"<a href='{html_text(url)}'>{html_text(label)}</a>"

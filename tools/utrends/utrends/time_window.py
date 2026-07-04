import re

WindowParseResult = tuple[int, None] | tuple[None, str]


def format_window(hours: int) -> str:
    if hours % 24 == 0:
        days = hours // 24
        return f"{days} дн."
    return f"{hours} ч."


def parse_window_arg(
    text: str | None,
    default_hours: int,
    max_hours: int,
) -> WindowParseResult:
    args = (text or "").split(maxsplit=1)
    if len(args) < 2:
        return default_hours, None

    raw = args[1].strip().lower()
    match = re.fullmatch(r"(\d+)\s*([hdчд]?)", raw)
    if not match:
        return None, "Укажите окно в формате 6h, 24h, 3d или 6d."

    value = int(match.group(1))
    unit = match.group(2) or "h"
    hours = value * 24 if unit in {"d", "д"} else value
    if hours <= 0:
        return None, "Окно должно быть больше нуля."
    if hours > max_hours:
        return None, f"Максимальное окно — {format_window(max_hours)}."
    return hours, None

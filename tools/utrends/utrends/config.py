import os


def env_int(name: str, default: int, minimum: int = 1) -> int:
    """Read an integer environment variable and validate its lower bound."""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default

    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer, got {raw!r}") from exc

    if value < minimum:
        raise RuntimeError(f"{name} must be >= {minimum}, got {value}")
    return value

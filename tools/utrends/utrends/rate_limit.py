import math
import time


class RateLimiter:
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._last_calls: dict[tuple[int, str], float] = {}

    def retry_after(self, chat_id: int, command: str, cooldown_seconds: int) -> int:
        """Return remaining cooldown or reserve the command execution."""
        now = self._clock()
        key = (chat_id, command)
        elapsed = now - self._last_calls.get(key, float("-inf"))
        if elapsed < cooldown_seconds:
            return math.ceil(cooldown_seconds - elapsed)
        self._last_calls[key] = now
        return 0

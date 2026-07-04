from pathlib import Path
import sys


def is_bot_process(command: str) -> bool:
    return "python" in command and ("bot.py" in command or "utrends.bot" in command)


def main() -> int:
    for cmdline_path in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            command = cmdline_path.read_bytes().replace(b"\0", b" ").decode(errors="ignore")
        except OSError:
            continue
        if is_bot_process(command):
            return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())

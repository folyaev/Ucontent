from datetime import datetime, timezone
from pathlib import Path
import sqlite3


def create_backup(db_path: str, backup_dir: str, keep_last: int = 7) -> Path:
    """Create a consistent SQLite backup and prune older backup files."""
    source_path = Path(db_path)
    target_dir = Path(backup_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    target_path = target_dir / f"{source_path.stem}-{timestamp}.db"

    source = sqlite3.connect(source_path)
    target = sqlite3.connect(target_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()

    prune_backups(target_dir, source_path.stem, keep_last)
    return target_path


def list_backups(backup_dir: str, db_stem: str) -> list[Path]:
    return sorted(Path(backup_dir).glob(f"{db_stem}-*.db"), key=lambda path: path.name)


def prune_backups(backup_dir: str, db_stem: str, keep_last: int) -> None:
    if keep_last <= 0:
        return
    backups = list_backups(backup_dir, db_stem)
    for path in backups[:-keep_last]:
        path.unlink(missing_ok=True)

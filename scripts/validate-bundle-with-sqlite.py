#!/usr/bin/env python3
import json
import sqlite3
import sys
from pathlib import Path

bundle = Path(sys.argv[1]).resolve()
manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
for relative in manifest["applyOrder"]:
    connection.executescript((bundle / relative).read_text(encoding="utf-8"))
for table in manifest["tables"]:
    actual = connection.execute(f'SELECT COUNT(*) FROM "{table["target"].replace(chr(34), chr(34)*2)}"').fetchone()[0]
    if actual != table["rows"]:
        raise SystemExit(f'row count mismatch for {table["target"]}: {actual} != {table["rows"]}')
violations = connection.execute("PRAGMA foreign_key_check").fetchall()
if violations:
    raise SystemExit(f"foreign key violations: {violations!r}")
print(f'validated {len(manifest["tables"])} tables and {sum(t["rows"] for t in manifest["tables"])} rows')

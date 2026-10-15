#!/usr/bin/python3
"""Online SQLite backup, including committed WAL data; keep 14 daily snapshots."""
import datetime
import pathlib
import sqlite3

directory = pathlib.Path('/var/backups/agent-mailbox')
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
target = directory / f'mailbox-{stamp}.sqlite3'
with sqlite3.connect('file:/var/lib/agent-mailbox/mailbox.db?mode=ro', uri=True) as source:
    with sqlite3.connect(target) as destination:
        source.backup(destination)
        if destination.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise RuntimeError('Backup integrity check failed')
for old in sorted(directory.glob('mailbox-*.sqlite3'), reverse=True)[14:]:
    old.unlink()
print(f'Backup verified: {target.name}')

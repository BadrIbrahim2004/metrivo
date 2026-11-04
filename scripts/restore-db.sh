# Metrivo — restore a backup into the production database
# !!! DESTRUCTIVE TO CURRENT DATA: run only during a genuine recovery. !!!
# Usage:
#   BACKUP_FILE=./backups/metrivo_20261030_020000.sql.gz ./scripts/restore-db.sh
# The script asks for confirmation before doing anything.

set -euo pipefail

BACKUP_FILE="${BACKUP_FILE:?Set BACKUP_FILE=./backups/<file>.sql.gz}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

echo "You are about to REPLACE the current database with: $BACKUP_FILE"
read -r -p "Type RESTORE to continue: " confirm
if [ "$confirm" != "RESTORE" ]; then
  echo "Aborted."
  exit 0
fi

gunzip -c "$BACKUP_FILE" | docker compose -f compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo "Restore finished."

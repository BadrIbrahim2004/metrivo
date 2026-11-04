# Metrivo — daily production database backup
# Runs INSIDE the db container; dumps to a host-mounted folder ./backups.
# Schedule with Task Scheduler (Windows) or cron (Linux):
#   0 2 * * * /path/to/scripts/backup-db.sh
#
# Never restores, drops or resets anything — read-only dump via pg_dump.

set -euo pipefail

STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

mkdir -p "$OUT_DIR"

echo "Dumping metrivo database -> $OUT_DIR/metrivo_$STAMP.sql.gz"
docker compose -f compose.prod.yml exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  | gzip > "$OUT_DIR/metrivo_$STAMP.sql.gz"

echo "Pruning backups older than $KEEP_DAYS days..."
find "$OUT_DIR" -name 'metrivo_*.sql.gz' -mtime +"$KEEP_DAYS" -delete

echo "Backup done."

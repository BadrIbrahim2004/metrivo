BEGIN;

INSERT INTO
  public."TenantPermission" (id, key, description)
VALUES
  (
    'permission-reports-read',
    'reports.read',
    'View dashboards, reports, and analytics for the branch'
  ) ON CONFLICT (key) DO NOTHING;

COMMIT;
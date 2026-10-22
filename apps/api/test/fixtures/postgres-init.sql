-- Executed by run-postgres-integration.cjs only after it verifies the
-- unique Compose project, container image, loopback port, tmpfs, and bootstrap
-- PostgreSQL identity. This file is deliberately not an entrypoint script.

CREATE ROLE metrivo_pos_test_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE metrivo_pos_test_migrator
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE metrivo_pos_test_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

GRANT metrivo_pos_test_owner TO metrivo_pos_test_migrator;
CREATE DATABASE metrivo_pos_test OWNER metrivo_pos_test_owner;
\connect metrivo_pos_test

ALTER SCHEMA public OWNER TO metrivo_pos_test_owner;

CREATE TABLE public.metrivo_pos_test_identity (
  identity_key TEXT PRIMARY KEY,
  identity_value TEXT NOT NULL
);

INSERT INTO public.metrivo_pos_test_identity (identity_key, identity_value)
VALUES ('environment', :'test_marker');

GRANT CONNECT ON DATABASE metrivo_pos_test TO metrivo_pos_test_migrator;
GRANT CONNECT ON DATABASE metrivo_pos_test TO metrivo_pos_test_app;
GRANT USAGE ON SCHEMA public TO metrivo_pos_test_app;
GRANT SELECT ON public.metrivo_pos_test_identity TO metrivo_pos_test_app;

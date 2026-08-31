-- Migração para bancos criados ANTES do Tree de dois níveis.
-- Bancos novos já nascem certos (db/init/02_schema.sql) e não precisam disto.
--
--   docker exec -i ia_coder_postgres psql -U iacoder -d iacoder < db/migrations/001_tree_dois_niveis.sql

BEGIN;

-- O grafo antigo era genérico demais para ser útil; sai inteiro.
DROP FUNCTION IF EXISTS tree_similar(uuid, integer);
DROP FUNCTION IF EXISTS tree_search(vector, integer);
DROP TABLE IF EXISTS tree_edges;
DROP TABLE IF EXISTS tree_nodes;

CREATE TABLE IF NOT EXISTS subjects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  title        text NOT NULL,
  summary      text NOT NULL,
  persona      text,
  project_path text,
  workflow_id  uuid REFERENCES workflows(id) ON DELETE SET NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  content      text,
  embedding    vector(768),
  hits         integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subjects_embedding_idx
  ON subjects USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS subjects_title_trgm ON subjects USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS subjects_summary_trgm ON subjects USING gin (summary gin_trgm_ops);

CREATE TABLE IF NOT EXISTS subject_links (
  from_subject uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  to_subject   uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'relates',
  weight       real NOT NULL DEFAULT 1,
  PRIMARY KEY (from_subject, to_subject, kind),
  CHECK (from_subject <> to_subject)
);

DO $$ BEGIN
  CREATE TYPE component_kind AS ENUM (
    'microfrontend', 'microservice', 'api', 'database', 'cache',
    'queue', 'job', 'external', 'library', 'infra'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS components (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name       text NOT NULL,
  kind       component_kind NOT NULL DEFAULT 'microservice',
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, key)
);

CREATE TABLE IF NOT EXISTS component_links (
  from_component uuid NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  to_component   uuid NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'calls',
  label          text,
  PRIMARY KEY (from_component, to_component, kind),
  CHECK (from_component <> to_component)
);

CREATE OR REPLACE FUNCTION subject_search(query vector(768), k integer DEFAULT 5)
RETURNS TABLE (id uuid, slug text, title text, summary text, similarity real)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.slug, s.title, s.summary, 1 - (s.embedding <=> query) AS similarity
  FROM subjects s WHERE s.embedding IS NOT NULL
  ORDER BY s.embedding <=> query LIMIT k;
$$;

CREATE OR REPLACE FUNCTION subject_search_text(query text, k integer DEFAULT 5)
RETURNS TABLE (id uuid, slug text, title text, summary text, similarity real)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.slug, t.title, t.summary, t.sim
  FROM (
    SELECT s.id, s.slug, s.title, s.summary,
           GREATEST(
             similarity(s.title, query),
             similarity(s.summary, query),
             word_similarity(query, s.title),
             word_similarity(query, s.summary)
           ) AS sim
    FROM subjects s
  ) t
  WHERE t.sim > 0.12
  ORDER BY t.sim DESC
  LIMIT k;
$$;

COMMIT;

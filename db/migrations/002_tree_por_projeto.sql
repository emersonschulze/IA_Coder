-- Migração: o Tree passa a ser POR PROJETO.
--
-- Antes, `subjects.slug` era único no banco inteiro e nenhuma consulta olhava
-- `project_path` — a coluna era gravada e nunca lida. Como a ferramenta troca de
-- projeto em tempo de execução contra o mesmo banco, dois projetos com um
-- assunto de mesmo nome ("autenticacao") colidiam: o upsert de um reescrevia o
-- outro e apagava a stack dele, e o recall depois injetava esse assunto alheio
-- no prompt anunciando-o como "conhecimento já confirmado neste projeto".
--
-- Bancos novos já nascem certos (db/init/02_schema.sql).
--
--   docker exec -i ia_coder_postgres psql -U iacoder -d iacoder < db/migrations/002_tree_por_projeto.sql

BEGIN;

-- Linha antiga sem projeto vira do projeto "desconhecido" em vez de sumir: é
-- conhecimento que alguém confirmou um dia, e apagar seria pior do que
-- desencaixar.
UPDATE subjects SET project_path = '' WHERE project_path IS NULL;
ALTER TABLE subjects ALTER COLUMN project_path SET NOT NULL;
ALTER TABLE subjects ALTER COLUMN project_path SET DEFAULT '';

-- A unicidade que vale agora é o par. O nome do índice é o que o servidor
-- procura no boot para saber se esta migração já rodou (apps/server/src/db.ts).
ALTER TABLE subjects DROP CONSTRAINT IF EXISTS subjects_slug_key;
DROP INDEX IF EXISTS subjects_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS subjects_project_slug_idx ON subjects (project_path, slug);

-- As buscas passam a receber o projeto. `project` sem valor mantém o
-- comportamento antigo (varre tudo) para quem chamar de fora do servidor.
DROP FUNCTION IF EXISTS subject_search(vector, integer);
CREATE OR REPLACE FUNCTION subject_search(query vector(768), k integer DEFAULT 5, project text DEFAULT NULL)
RETURNS TABLE (id uuid, slug text, title text, summary text, similarity real)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.slug, s.title, s.summary, 1 - (s.embedding <=> query) AS similarity
  FROM subjects s
  WHERE s.embedding IS NOT NULL
    AND (project IS NULL OR s.project_path = project)
  ORDER BY s.embedding <=> query
  LIMIT k;
$$;

DROP FUNCTION IF EXISTS subject_search_text(text, integer);
CREATE OR REPLACE FUNCTION subject_search_text(query text, k integer DEFAULT 5, project text DEFAULT NULL)
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
    WHERE project IS NULL OR s.project_path = project
  ) t
  WHERE t.sim > 0.12
  ORDER BY t.sim DESC
  LIMIT k;
$$;

-- O painel lista os assuntos do projeto ordenados por `updated_at`.
CREATE INDEX IF NOT EXISTS subjects_project_updated_idx ON subjects (project_path, updated_at DESC);

COMMIT;

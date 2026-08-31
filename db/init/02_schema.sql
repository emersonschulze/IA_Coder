-- =============================================================================
-- IA_Coder — esquema
--
-- Espelha o protocolo em docs/PROTOCOLO.md: tudo que a interface mostra tem
-- lastro aqui. Cada evento emitido no WebSocket nasce de uma linha destas
-- tabelas, o que torna qualquer sessão reproduzível depois (replay).
-- =============================================================================

-- ---------------------------------------------------------------- catálogos --
-- Agentes e skills são catálogo, não estado de execução: existem mesmo quando
-- nada está rodando. É o que garante a regra da interface de sempre listar
-- TODOS os agentes e skills enquanto a ferramenta está ociosa.

CREATE TABLE agents (
  id          text PRIMARY KEY,
  name        text        NOT NULL,
  role        text        NOT NULL,
  initials    text,
  color       text        NOT NULL DEFAULT '#22d3ee',
  system_role text,                                   -- prompt de sistema do agente
  model       text,
  enabled     boolean     NOT NULL DEFAULT true,
  position    integer     NOT NULL DEFAULT 0,          -- ordem de exibição no painel
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skills (
  id         text PRIMARY KEY,
  name       text        NOT NULL,
  detail     text        NOT NULL,
  initials   text,
  color      text        NOT NULL DEFAULT '#7dd3fc',
  playbook   text,                                     -- instruções da skill
  enabled    boolean     NOT NULL DEFAULT true,
  position   integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Quais skills cada agente domina. Um agente só recebe etapa de skill que ele tem.
CREATE TABLE agent_skills (
  agent_id   text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id   text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  proficiency smallint NOT NULL DEFAULT 3 CHECK (proficiency BETWEEN 1 AND 5),
  PRIMARY KEY (agent_id, skill_id)
);

-- ----------------------------------------------------------------- execução --

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  runtime      text        NOT NULL DEFAULT 'powershell',
  plan         text        NOT NULL DEFAULT 'PRO',
  tokens_used  bigint      NOT NULL DEFAULT 0,
  tokens_limit bigint      NOT NULL DEFAULT 200000,
  cost_usd     numeric(10,4) NOT NULL DEFAULT 0,
  context_pct  smallint    NOT NULL DEFAULT 0
);

CREATE TYPE workflow_state AS ENUM ('idle', 'running', 'done', 'failed', 'cancelled');
CREATE TYPE block_state    AS ENUM ('queued', 'running', 'done', 'error');
CREATE TYPE log_level      AS ENUM ('info', 'ok', 'warn', 'error');
CREATE TYPE ref_kind       AS ENUM ('agent', 'skill', 'block', 'archive');

CREATE TABLE workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title       text NOT NULL,                            -- o texto que o usuário pediu
  prompt      text NOT NULL,
  source      text NOT NULL DEFAULT 'text' CHECK (source IN ('text', 'voice')),
  state       workflow_state NOT NULL DEFAULT 'idle',
  step        integer NOT NULL DEFAULT 0,
  total_steps integer NOT NULL DEFAULT 0,
  progress    smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  eta_seconds integer,
  summary     text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ON workflows (session_id, started_at DESC);

-- Um bloco por agente participante — o "Agent N fazendo X item" da tela.
CREATE TABLE blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  agent_id    text NOT NULL REFERENCES agents(id),
  skill_id    text          REFERENCES skills(id),
  idx         integer NOT NULL,
  action      text    NOT NULL DEFAULT '',
  state       block_state NOT NULL DEFAULT 'queued',
  progress    smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  started_at  timestamptz,
  finished_at timestamptz,
  UNIQUE (workflow_id, idx)
);
CREATE INDEX ON blocks (workflow_id);

CREATE TABLE block_logs (
  id       bigserial PRIMARY KEY,
  block_id uuid NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  ts       timestamptz NOT NULL DEFAULT now(),
  level    log_level NOT NULL DEFAULT 'info',
  text     text NOT NULL,
  -- Saída crua do PowerShell, quando a linha veio de um comando.
  command  text,
  exit_code integer
);
CREATE INDEX ON block_logs (block_id, ts);
CREATE INDEX ON block_logs USING gin (text gin_trgm_ops);

CREATE TABLE artifacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid REFERENCES workflows(id) ON DELETE CASCADE,
  block_id    uuid REFERENCES blocks(id) ON DELETE SET NULL,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'code',   -- md | png | pptx | code | json | pdf
  path        text NOT NULL,                  -- caminho relativo a ARTIFACTS_DIR
  bytes       bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON artifacts (workflow_id, created_at DESC);
CREATE INDEX ON artifacts USING gin (name gin_trgm_ops);

-- Histórico das setas. Guardar isso permite reproduzir a animação de um
-- workflow inteiro depois — quem estava ligado a quê, e quando.
CREATE TABLE links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  from_kind      ref_kind NOT NULL,
  from_id        text NOT NULL,
  to_kind        ref_kind NOT NULL,
  to_id          text NOT NULL,
  label          text,
  color          text,
  activated_at   timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz
);
CREATE INDEX ON links (workflow_id, activated_at);

-- Consumo por evento, para o painel Status e para auditar custo.
CREATE TABLE usage_events (
  id            bigserial PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workflow_id   uuid REFERENCES workflows(id) ON DELETE SET NULL,
  agent_id      text REFERENCES agents(id),
  ts            timestamptz NOT NULL DEFAULT now(),
  model         text,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd      numeric(10,6) NOT NULL DEFAULT 0
);
CREATE INDEX ON usage_events (session_id, ts DESC);

-- ------------------------------------------------------------- Tree (nível 1) --
-- Um "assunto" é uma investigação que o usuário CONFIRMOU que ficou boa.
-- É o que evita pagar de novo pela mesma análise: da próxima vez que alguém
-- pedir algo parecido, o servidor recupera o resumo daqui e injeta como
-- contexto, em vez de mandar o agente descobrir tudo outra vez.

CREATE TABLE subjects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  title        text NOT NULL,
  summary      text NOT NULL,              -- o aprendizado, em poucas linhas
  persona      text,                        -- quem pediu: "Dev A", "Analista"…
  project_path text,
  workflow_id  uuid REFERENCES workflows(id) ON DELETE SET NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  content      text,                        -- texto que gerou o embedding
  embedding    vector(768),
  hits         integer NOT NULL DEFAULT 0,  -- quantas vezes já foi reaproveitado
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subjects_embedding_idx
  ON subjects USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX ON subjects USING gin (title gin_trgm_ops);
CREATE INDEX ON subjects USING gin (summary gin_trgm_ops);

-- Como os assuntos conversam entre si. É o grafo que aparece na tela inicial.
CREATE TABLE subject_links (
  from_subject uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  to_subject   uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'relates',  -- relates | depends | extends
  weight       real NOT NULL DEFAULT 1,
  PRIMARY KEY (from_subject, to_subject, kind),
  CHECK (from_subject <> to_subject)
);
CREATE INDEX ON subject_links (to_subject);

-- --------------------------------------------------------- Tree (nível 2) --
-- Ao clicar num assunto, abre a stack dele: quais micro frontends, micro
-- serviços, bancos e caches participam daquela demanda — e como se ligam.

CREATE TYPE component_kind AS ENUM (
  'microfrontend', 'microservice', 'api', 'database', 'cache',
  'queue', 'job', 'external', 'library', 'infra'
);

CREATE TABLE components (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  key        text NOT NULL,                 -- 'mf-checkout', 'api-pedidos', 'redis'
  name       text NOT NULL,
  kind       component_kind NOT NULL DEFAULT 'microservice',
  detail     text,                          -- stack, repositório, observações
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, key)
);
CREATE INDEX ON components (subject_id);

CREATE TABLE component_links (
  from_component uuid NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  to_component   uuid NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'calls',  -- calls | reads | writes | publishes | consumes
  label          text,
  PRIMARY KEY (from_component, to_component, kind),
  CHECK (from_component <> to_component)
);
CREATE INDEX ON component_links (to_component);

-- ------------------------------------------------------------------ busca --

-- Assuntos semanticamente próximos de um embedding (o pedido do usuário).
CREATE OR REPLACE FUNCTION subject_search(query vector(768), k integer DEFAULT 5)
RETURNS TABLE (id uuid, slug text, title text, summary text, similarity real)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.slug, s.title, s.summary, 1 - (s.embedding <=> query) AS similarity
  FROM subjects s
  WHERE s.embedding IS NOT NULL
  ORDER BY s.embedding <=> query
  LIMIT k;
$$;

-- Alternativa sem embeddings: semelhança de texto (pg_trgm). É o que roda
-- quando o Ollama não está de pé — pior, mas o Tree continua útil.
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

-- updated_at automático.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER subjects_touch
  BEFORE UPDATE ON subjects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

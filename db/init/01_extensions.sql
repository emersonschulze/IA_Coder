-- Extensões usadas pelo IA_Coder.
-- Rodam uma única vez, quando o volume do Postgres é criado.

CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector: embeddings do Tree
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- busca aproximada em logs e nomes de artefato

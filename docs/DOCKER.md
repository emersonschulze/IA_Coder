# Infraestrutura local

## A decisão que manda em tudo

O IA_Coder dá **spawn no PowerShell da sua máquina** e mexe nos seus repositórios.
Um container Linux não faz isso: não enxerga o `powershell.exe`, não enxerga o `G:\`,
não enxerga suas credenciais de `git`. Por isso a divisão é:

```
Windows (host)                          Docker (containers)
├── apps/server   ← spawn do PowerShell  ├── postgres + pgvector   (estado + Tree)
├── apps/web      ← Vite                 ├── redis                 (eventos + fila)
└── seus repositórios                    └── ollama    (opcional)
```

Containerizar o servidor transformaria a ferramenta num executor de sandbox — que é
justamente o que você **não** quer aqui. O que vai para o Docker é só o que é
infraestrutura pura e chata de instalar no Windows.

## Subindo

```powershell
copy .env.example .env      # troque POSTGRES_PASSWORD
docker compose up -d        # postgres + redis
docker compose ps
```

Sem Adminer no compose — quem usa DBeaver (ou outro cliente) aponta direto
para `localhost:5433`, usuário e senha do `.env`.

Atalhos:

```powershell
.\scripts\infra.ps1 up            # o mesmo que acima
.\scripts\infra.ps1 up -Ai        # + Ollama (embeddings locais)
.\scripts\infra.ps1 psql          # psql direto no banco
.\scripts\infra.ps1 pull-model    # baixa o modelo de embeddings
.\scripts\infra.ps1 reset         # apaga os volumes e recria do zero
```

## Os serviços, e por que cada um existe

### `postgres` — pgvector/pgvector:pg17 · porta 5433

Guarda **tudo**: sessões, workflows, blocos, logs linha a linha, artefatos, o
histórico das setas e o grafo do Tree. Duas consequências práticas:

- **Replay.** Como cada seta é gravada com `activated_at`/`deactivated_at`, dá para
  reproduzir a animação de um workflow inteiro depois — útil para entender por que
  um agente decidiu o que decidiu.
- **Tree semântico.** `tree_nodes.embedding` é um `vector(768)` com índice HNSW.
  O Tree liga assuntos por *sentido*, não só pelos vínculos que os agentes criaram
  explicitamente. As funções `tree_search(embedding, k)` e `tree_similar(node, k)`
  já estão no banco.

A porta no host é **5433** de propósito, para não brigar com um Postgres que você
já tenha instalado no Windows. Dentro da rede do compose continua sendo 5432.

O servidor **não precisa de `DATABASE_URL`**: ele monta o endereço a partir das
mesmas variáveis que o compose usa (`POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`, `POSTGRES_PORT`), com os mesmos padrões. Uma fonte da verdade só.
Declare `DATABASE_URL` apenas para apontar para um banco fora do compose. No boot
ele diz no log qual endereço usou e de onde tirou:

```
[db] conectado em postgresql://iacoder:***@localhost:5433/iacoder (via docker-compose)
```

Os scripts em `db/init/` rodam **uma única vez**, quando o volume é criado. Se você
mudar o esquema, use `.\scripts\infra.ps1 reset` (apaga os dados) ou aplique uma
migration manual.

### `redis` — redis:7-alpine · porta 6379

Dois papéis:

- **Pub/sub**: os agentes rodam em paralelo e publicam eventos (`block.log`,
  `link.activated`, …); o gateway WebSocket assina e repassa para a interface. Sem
  isso, dois agentes escrevendo ao mesmo tempo viram uma corrida.
- **Fila de trabalho**: as etapas do workflow entram numa fila, com retry e
  visibilidade de quem pegou o quê.

`appendonly yes` e `maxmemory-policy noeviction` — fila não pode perder item por
pressão de memória.

### `ollama` — perfil `ai` · porta 11434

Embeddings **locais** para o Tree, com `nomic-embed-text` (768 dimensões). Sem chave
de API, sem mandar seu código para fora. Depois de subir, baixe o modelo uma vez:

```powershell
docker exec -it ia_coder_ollama ollama pull nomic-embed-text
```

Se preferir usar uma API de embeddings, ponha `EMBEDDINGS_PROVIDER=none` (ou o
provedor que eu implementar no server) e não suba este perfil — ele é o único
serviço pesado do conjunto.

> **Trocou de modelo de embedding? Troque a dimensão.** `vector(768)` é fixo por
> coluna no pgvector. Um modelo de 1024 ou 1536 dimensões exige alterar
> `db/init/02_schema.sql`, `EMBEDDINGS_DIM` no `.env` e recriar o banco.

## O que deliberadamente NÃO está aqui

- **Adminer.** Chegou a estar no compose, mas quem já tem o DBeaver (ou outro
  cliente de Postgres) não precisa de mais um serviço web só para olhar
  tabela — é só apontar para `localhost:5433` com o usuário/senha do `.env`.
- **MinIO / S3.** Os artefatos (MD, imagens, decks) vão para `workspace/artifacts/`,
  uma pasta comum do Windows. O painel Archives quer "clique fácil de abrir" — uma
  pasta que abre no Explorer resolve isso melhor que um bucket com URL assinada.
  O banco guarda só o caminho relativo.
- **Servidor e frontend em container.** Explicado no topo.
- **Um banco vetorial dedicado (Qdrant, Weaviate, Milvus, Pinecone).** São bancos
  que existem *só* para guardar embeddings e responder "quais vetores se parecem
  com este?" muito rápido, em escala de milhões a bilhões. Seriam uma **alternativa**
  ao pgvector, não um complemento.

  Ficamos com o pgvector porque um projeto de código gera na casa de dezenas de
  milhares de vetores — volume em que o Postgres com índice HNSW responde em poucos
  milissegundos. E há um ganho que o banco dedicado não dá: no pgvector o embedding
  mora **na mesma linha** do nó do Tree, então dá para juntar similaridade semântica
  com filtro relacional numa consulta só ("nós parecidos com isto, do tipo `file`,
  tocados neste workflow"). Com Qdrant, isso vira duas consultas em dois bancos que
  você precisa manter em sincronia — mais peça para subir, mais coisa para
  dessincronizar. Se um dia o volume explodir, migrar é trocar a camada de busca;
  o esquema relacional continua o mesmo.

## Conferindo se está de pé

```powershell
docker compose ps                                     # os dois "healthy"
docker exec ia_coder_postgres psql -U iacoder -d iacoder -c "\dt"
docker exec ia_coder_postgres psql -U iacoder -d iacoder -c "select count(*) from agents;"   # 4
docker exec ia_coder_redis redis-cli ping             # PONG
```

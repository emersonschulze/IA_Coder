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

Atalhos — no PowerShell:

```powershell
.\scripts\infra.ps1 up            # o mesmo que acima
.\scripts\infra.ps1 up -Ai        # + Ollama (embeddings locais)
.\scripts\infra.ps1 psql          # psql direto no banco
.\scripts\infra.ps1 pull-model    # baixa o modelo de embeddings
.\scripts\infra.ps1 reset         # apaga os volumes e recria do zero
```

Os mesmos atalhos no WSL (é comum subir o compose por lá, mesmo com o servidor
rodando no Windows). Ele detecta sozinho se o `docker` precisa de `sudo`:

```bash
./scripts/infra.sh up             # o mesmo que acima
./scripts/infra.sh up --ai        # + Ollama
./scripts/infra.sh up --voice     # + Whisper e Piper
./scripts/infra.sh check          # está tudo no ar E certo?
./scripts/infra.sh logs whisper   # o log de um serviço só
./scripts/infra.sh psql
./scripts/infra.sh pull-model
./scripts/infra.sh recreate whisper  # um serviço do zero, volume junto
./scripts/infra.sh reset-db       # recria SÓ o Postgres, reaplicando db/init
./scripts/infra.sh reset          # apaga TODOS os volumes e recria do zero
```

O `check` responde à pergunta que `ps` não responde: container verde não quer
dizer banco pronto. Ele confere conexão, as três extensões, as tabelas que o
servidor usa (incluindo `subjects` e `components`) e o ping do Redis — e sai com
código 1 se algo faltar, então serve em script.

Whisper, Piper e Ollama entram na conferência **só se já estiverem de pé**: quem
não subiu não é problema, mas quem subiu e está em `restarting` é — esse é o laço
de morte de um container que morre no boot, e nele a interface fica esperando por
um serviço que nunca vai responder. O `check` aponta o `logs <serviço>`, que é o
único lugar onde está o motivo.

Vale para os dois lugares: o script funciona tanto em `scripts/`, dentro do
repositório, quanto solto ao lado do `docker-compose.yml` — que é o caso de quem
copiou só `db/`, `docker/` e o compose para dentro do WSL. Ele procura o compose
na própria pasta e, se não achar, na de cima. O `.env` é opcional: sem ele, tudo
cai nos mesmos padrões do compose.

O `reset-db` existe porque `reset` é caro à toa quando o problema é só o banco:
ele apaga também os modelos já baixados de Whisper, Piper e Ollama, que são
gigabytes. O `reset-db` derruba apenas o volume `ia_coder_pgdata` e espera o
banco aceitar conexão antes de te mostrar as extensões e as tabelas que
nasceram do `db/init`.

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
mudar o esquema, recrie o banco (`.\scripts\infra.ps1 reset` no PowerShell,
`./scripts/infra.sh reset-db` no WSL) ou aplique uma migration manual.

Sintoma clássico de volume criado ANTES de `db/init/` existir: qualquer coisa que
toque em `vector(768)` falha com `type "vector" does not exist`, porque o
`CREATE EXTENSION vector` do `01_extensions.sql` nunca rodou. Como as migrations
vêm dentro de um `BEGIN`, o resto do arquivo vira uma cascata de
`current transaction is aborted` e termina em `ROLLBACK` — nada foi aplicado. A
saída é recriar o volume, não insistir na migration.

E depois de recriar, **não rode `db/migrations/001_tree_dois_niveis.sql`**: o
`db/init/02_schema.sql` já cria `subjects`, `subject_links` e `components`. Aquela
migration existe só para volumes anteriores ao Tree de dois níveis.

O `recreate <serviço>` descarta container e volume de um serviço só e o sobe de
novo, mostrando as primeiras linhas do log — é o caminho para container em laço de
restart, onde o problema costuma ser algo pela metade dentro do volume (um modelo
cortado no meio do download, por exemplo). Ele escolhe o perfil sozinho (`whisper`
e `piper` são `voice`; `ollama` é `ai`) e sabe que o Piper é imagem nossa, então
reconstrói em vez de baixar. Para o `postgres` ele recusa e manda usar `reset-db`,
que ainda confere o `db/init` depois.

## Rede que inspeciona TLS (proxy corporativo)

Sintoma: o Whisper (ou o Ollama) morre no boot e fica em laço de restart, com
esta linha no log:

```
[SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate
```

O proxy da empresa abre a conexão com o Hugging Face, reassina com o certificado
dela e reentrega. O Windows confia nessa raiz porque o TI a instalou lá; o
container não — ele traz só as CAs públicas. Resultado: o download do modelo
falha na verificação.

A saída é dar a raiz da empresa para o container. Defina no `.env`:

```bash
CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
```

e o `scripts/infra.sh` passa a incluir sozinho o `docker-compose.proxy.yml`, que
monta esse arquivo em `/certs/ca.pem` e aponta `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`
e `CURL_CA_BUNDLE` para lá — três nomes porque três bibliotecas diferentes olham
cada uma a sua. Na mão, é
`docker compose -f docker-compose.yml -f docker-compose.proxy.yml … up -d`.

Esse caminho só serve se **o WSL já confiar** no proxy — confira com
`curl -I https://huggingface.co`. Se o curl falhar igual, instale a raiz no WSL
antes (exporte o `.crt` pelo `certmgr.msc` do Windows, copie para
`/usr/local/share/ca-certificates/` e rode `sudo update-ca-certificates`).

O Piper cai na mesma armadilha, com um agravante: ele baixa a voz **na primeira
fala**, não no boot. Fica verde e saudável até você falar pela primeira vez — por
isso ele está no `docker-compose.proxy.yml` também.

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

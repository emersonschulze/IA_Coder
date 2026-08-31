#!/usr/bin/env bash
#
# Atalhos da infraestrutura do IA_Coder — versão WSL/Linux.
# Espelha o scripts/infra.ps1, para quem sobe o compose pelo WSL.
#
#   ./scripts/infra.sh up               postgres + redis
#   ./scripts/infra.sh up --ai          + Ollama (embeddings locais)
#   ./scripts/infra.sh up --voice       + Whisper e Piper (modo conversa)
#   ./scripts/infra.sh ps               o que está de pé
#   ./scripts/infra.sh check            diz se está TUDO no ar e certo
#   ./scripts/infra.sh logs             segue o log de todos
#   ./scripts/infra.sh logs whisper     segue o log de um serviço só
#   ./scripts/infra.sh psql             abre o psql no banco
#   ./scripts/infra.sh redis            abre o redis-cli
#   ./scripts/infra.sh pull-model       baixa o modelo de embeddings
#   ./scripts/infra.sh recreate whisper recria UM serviço do zero (com o volume)
#   ./scripts/infra.sh reset-db         recria SÓ o Postgres, reaplicando db/init
#   ./scripts/infra.sh reset            apaga TODOS os volumes e recria do zero
#   ./scripts/infra.sh reset --voice    idem, e devolve Whisper e Piper junto
#
set -euo pipefail

aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -f "$aqui/docker-compose.yml" ]; then
  cd "$aqui"                       # o script está do lado do compose
elif [ -f "$aqui/../docker-compose.yml" ]; then
  cd "$aqui/.."                    # o script está em scripts/, no repositório
else
  echo "não achei docker-compose.yml nem em $aqui nem na pasta acima." >&2
  exit 1
fi

# O .env é opcional: sem ele, o compose e o servidor caem nos mesmos padrões
# (iacoder/iacoder/iacoder na 5433). Só copiamos o exemplo se ele veio junto.
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "⚠  .env criado a partir de .env.example — troque a senha do Postgres."
fi

# No WSL o Docker costuma exigir sudo, a menos que você esteja no grupo "docker".
# Testamos uma vez e usamos o que funcionar, em vez de exigir sudo sempre.
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
else
  DOCKER=(sudo docker)
fi

# Lê uma variável do .env sem dar `source` nele (que executaria o arquivo).
env_value() {
  local line
  line=$(grep -E "^$1=" .env 2>/dev/null | tail -1 || true)
  if [ -n "$line" ]; then
    line=${line#*=}
    line=${line%\"}; line=${line#\"}
    line=${line%\'}; line=${line#\'}
    printf '%s' "$line"
  else
    printf '%s' "$2"
  fi
}

PG_USER=$(env_value POSTGRES_USER iacoder)
PG_DB=$(env_value POSTGRES_DB iacoder)
PG_PORT=$(env_value POSTGRES_PORT 5433)
PROJECT=${COMPOSE_PROJECT_NAME:-ia_coder}

# Rede que inspeciona TLS (proxy corporativo): com CA_BUNDLE definido, entra a
# sobreposição que injeta a raiz da empresa nos containers que baixam modelo.
# Sem ela, o download morre com "certificate verify failed" e o container fica
# em laço de restart — o certificado que o proxy apresenta não é conhecido lá
# dentro, por mais que o Windows confie nele.
CA_BUNDLE=${CA_BUNDLE:-$(env_value CA_BUNDLE '')}
COMPOSE=(compose)
if [ -n "$CA_BUNDLE" ] && [ -f docker-compose.proxy.yml ]; then
  COMPOSE=(compose -f docker-compose.yml -f docker-compose.proxy.yml)
  export CA_BUNDLE
  # O sudo limpa o ambiente por padrão. Exportar não basta: a variável tem de
  # viajar como argumento dele, senão o compose nasce sem ela e para com
  # "required variable CA_BUNDLE is missing a value". Quem põe no .env não
  # passa por isso — o compose lê aquele arquivo por conta própria.
  if [ "${DOCKER[0]}" = 'sudo' ]; then
    DOCKER=(sudo "CA_BUNDLE=$CA_BUNDLE" docker)
  fi
fi

command=${1:-up}
shift || true

profiles=()
extras=()
for arg in "$@"; do
  case "$arg" in
    --ai)    profiles+=(--profile ai) ;;
    --voice) profiles+=(--profile voice) ;;
    -*) echo "opção desconhecida: $arg" >&2; exit 2 ;;
    # Qualquer outra coisa é o nome de um serviço: "logs whisper", "up postgres".
    *) extras+=("$arg") ;;
  esac
done

# Uma pergunta ao banco, resposta crua (sem cabeçalho, sem alinhamento).
consulta() {
  "${DOCKER[@]}" exec -i ia_coder_postgres psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" 2>/dev/null | tr -d '\r'
}

# Serviço que só existe com --voice ou --ai: se nem subiu, não é problema.
# Se subiu, tem de estar de pé — um container em "restarting" é laço de morte,
# e nesse estado a interface fica esperando por um serviço que nunca responde.
verifica_opcional() {
  local container=$1 rotulo=$2 servico=$3
  local estado saude
  estado=$("${DOCKER[@]}" inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true)
  [ -z "$estado" ] && return 0

  saude=$("${DOCKER[@]}" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)
  if [ "$estado" = 'running' ] && [ "$saude" != 'unhealthy' ]; then
    echo "ok   $rotulo no ar"
  else
    echo "FALHA  $rotulo em \"${saude:-$estado}\" — o porquê está em: ./scripts/infra.sh logs $servico"
    falhou=1
  fi
}

confirme() {
  echo "$1"
  read -r -p 'Digite SIM para continuar: ' resposta
  [ "$resposta" = 'SIM' ] || { echo 'cancelado.'; exit 0; }
}

case "$command" in
  up)
    "${DOCKER[@]}" "${COMPOSE[@]}" "${profiles[@]}" up -d ${extras[@]+"${extras[@]}"}
    "${DOCKER[@]}" "${COMPOSE[@]}" ps
    ;;
  down) "${DOCKER[@]}" "${COMPOSE[@]}" "${profiles[@]}" down ;;
  logs) "${DOCKER[@]}" "${COMPOSE[@]}" logs -f --tail=100 ${extras[@]+"${extras[@]}"} ;;
  ps)   "${DOCKER[@]}" "${COMPOSE[@]}" ps ;;
  psql) "${DOCKER[@]}" exec -it ia_coder_postgres psql -U "$PG_USER" -d "$PG_DB" ;;
  redis) "${DOCKER[@]}" exec -it ia_coder_redis redis-cli ;;
  pull-model)
    "${DOCKER[@]}" "${COMPOSE[@]}" --profile ai up -d ollama
    "${DOCKER[@]}" exec -it ia_coder_ollama ollama pull nomic-embed-text
    ;;

  # Os scripts de db/init/ rodam UMA vez, na criação do volume. É por isso que
  # recriar o banco é a forma de reaplicá-los — e por isso um volume criado antes
  # de db/init/ existir fica sem a extensão `vector`, fazendo qualquer coisa com
  # `vector(768)` falhar com "type \"vector\" does not exist".
  reset-db)
    confirme "Isto apaga os dados do POSTGRES (o Tree inteiro). Redis, Whisper, Piper e Ollama ficam intactos."
    "${DOCKER[@]}" "${COMPOSE[@]}" rm -sf postgres
    "${DOCKER[@]}" volume rm "${PROJECT}_pgdata"
    "${DOCKER[@]}" "${COMPOSE[@]}" up -d
    echo
    printf 'esperando o Postgres aceitar conexão'
    pronto=
    for _ in $(seq 1 60); do
      if "${DOCKER[@]}" exec -i ia_coder_postgres pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
        pronto=1
        break
      fi
      printf '.'
      sleep 1
    done
    echo
    if [ -z "$pronto" ]; then
      echo "O Postgres não subiu a tempo. Veja: ./scripts/infra.sh logs" >&2
      exit 1
    fi

    echo 'Extensões e tabelas que nasceram do db/init:'
    "${DOCKER[@]}" exec -i ia_coder_postgres psql -U "$PG_USER" -d "$PG_DB" -c '\dx'
    "${DOCKER[@]}" exec -i ia_coder_postgres psql -U "$PG_USER" -d "$PG_DB" -c '\dt'
    echo 'Pronto. NÃO rode db/migrations/001 — o schema novo já nasce com o Tree de dois níveis.'
    ;;

  # "Está tudo no ar?" não se responde com container verde: o Postgres pode
  # estar de pé e o banco vazio — foi exatamente o caso do volume sem a
  # extensão `vector`. Então conferimos o que a ferramenta realmente precisa.
  check)
    "${DOCKER[@]}" "${COMPOSE[@]}" ps
    echo
    falhou=0

    if "${DOCKER[@]}" exec -i ia_coder_postgres pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
      echo "ok   postgres aceitando conexão — localhost:$PG_PORT, base $PG_DB, usuário $PG_USER"
    else
      echo 'FALHA  postgres não responde (container no ar? veja ./scripts/infra.sh logs)'
      falhou=1
    fi

    if [ "$falhou" -eq 0 ]; then
      faltam=$(consulta "select coalesce(string_agg(e, ', '), '') from unnest(array['vector','pgcrypto','pg_trgm']) e where e not in (select extname from pg_extension)")
      if [ -z "$faltam" ]; then
        echo 'ok   extensões vector, pgcrypto e pg_trgm instaladas'
      else
        echo "FALHA  faltam extensões: $faltam  -> o db/init não rodou. Use: ./scripts/infra.sh reset-db"
        falhou=1
      fi

      faltam=$(consulta "select coalesce(string_agg(t, ', '), '') from unnest(array['agents','skills','workflows','blocks','artifacts','links','subjects','components']) t where t not in (select tablename from pg_tables where schemaname = 'public')")
      if [ -z "$faltam" ]; then
        # SQL entre aspas simples, comando entre aspas duplas — o contrário
        # faz o bash comer as aspas do 'public' antes do psql ver a consulta.
        tabelas=$(consulta "select count(*) from pg_tables where schemaname = 'public'")
        echo "ok   esquema completo ($tabelas tabelas, subjects e components inclusas)"
      else
        echo "FALHA  faltam tabelas: $faltam  -> use: ./scripts/infra.sh reset-db"
        falhou=1
      fi
    fi

    if [ "$("${DOCKER[@]}" exec -i ia_coder_redis redis-cli ping 2>/dev/null | tr -d '\r')" = 'PONG' ]; then
      echo 'ok   redis respondendo'
    else
      echo 'FALHA  redis não respondeu ao ping'
      falhou=1
    fi

    verifica_opcional ia_coder_whisper 'whisper (fala -> texto)' whisper
    verifica_opcional ia_coder_piper   'piper (texto -> fala)'   piper
    verifica_opcional ia_coder_ollama  'ollama (embeddings)'     ollama

    echo
    if [ "$falhou" -eq 0 ]; then
      echo 'Infraestrutura no ar. Agora é a vez do servidor, no Windows: no boot'
      echo "ele diz onde se conectou — tem de citar localhost:$PG_PORT e a base"
      echo "$PG_DB — e o painel Tree acende sozinho em até 10s, sem reiniciar nada."
    else
      echo 'Tem coisa acima para resolver. Os opcionais (whisper, piper, ollama) só'
      echo 'aparecem nesta lista depois que você os sobe, com --voice ou --ai.'
      exit 1
    fi
    ;;

  # Um serviço do zero: container, volume e imagem. É o caminho para quando o
  # container entra em laço de restart e você quer descartar o que ele baixou —
  # um modelo cortado no meio do download, por exemplo.
  recreate)
    servico=${extras[0]:-}
    perfil=()
    case "$servico" in
      whisper|piper) perfil=(--profile voice) ;;
      ollama)        perfil=(--profile ai) ;;
      redis)         ;;
      postgres)
        echo 'Para o banco use reset-db: ele ainda confere o db/init depois.' >&2
        exit 2 ;;
      '')
        echo 'diga qual serviço: ./scripts/infra.sh recreate whisper' >&2
        exit 2 ;;
      *)
        echo "serviço desconhecido: $servico" >&2
        exit 2 ;;
    esac

    # O volume tem o nome do serviço, menos o do Redis.
    volume=$servico
    [ "$servico" = 'redis' ] && volume=redisdata

    confirme "Isto apaga o container e o volume do $servico (o que ele já baixou se perde)."
    "${DOCKER[@]}" "${COMPOSE[@]}" "${perfil[@]}" rm -sf "$servico"
    "${DOCKER[@]}" volume rm "${PROJECT}_${volume}" 2>/dev/null       || echo "(volume ${PROJECT}_${volume} já não existia)"

    # O Piper é imagem nossa (docker/piper), então se reconstrói; o resto se baixa.
    if [ "$servico" = 'piper' ]; then
      "${DOCKER[@]}" "${COMPOSE[@]}" "${perfil[@]}" build --no-cache piper
    else
      "${DOCKER[@]}" "${COMPOSE[@]}" "${perfil[@]}" pull "$servico"
    fi
    "${DOCKER[@]}" "${COMPOSE[@]}" "${perfil[@]}" up -d --force-recreate "$servico"

    echo
    echo "Primeiras linhas do $servico — é aqui que aparece o motivo, se ele morrer:"
    sleep 3
    "${DOCKER[@]}" "${COMPOSE[@]}" "${perfil[@]}" logs --tail=40 "$servico"
    ;;

  # Tudo do zero. A derrubada sempre cita os dois perfis, senão container de
  # perfil desligado sobrevive à limpeza e você jura que apagou.
  # As imagens ficam no cache de propósito: baixar tudo de novo é lento e ainda
  # gasta cota do Docker Hub. Para descartá-las também:
  #   docker compose --profile ai --profile voice down -v --rmi all
  reset)
    confirme 'Isto apaga TODOS os volumes: Postgres, Redis e também os modelos já baixados de Whisper, Piper e Ollama.'
    "${DOCKER[@]}" "${COMPOSE[@]}" --profile ai --profile voice down -v --remove-orphans
    "${DOCKER[@]}" "${COMPOSE[@]}" "${profiles[@]}" up -d
    "${DOCKER[@]}" "${COMPOSE[@]}" ps
    ;;

  *)
    echo "comando desconhecido: $command" >&2
    sed -n '3,15p' "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
esac

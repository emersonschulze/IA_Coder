import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export type DbState =
  | 'connecting'      // tentando pela primeira vez
  | 'ok'              // conectado e com o esquema certo
  | 'unreachable'     // ninguém atendeu no endereço
  | 'relay-broken'    // alguém atendeu e derrubou: túnel da WSL velho
  | 'schema-missing'; // banco de pé, mas sem as tabelas do Tree

/**
 * "Não respondeu" e "atendeu e desligou na sua cara" são falhas diferentes, com
 * curas diferentes — e mandar `docker compose up -d` para a segunda faz você
 * rodar em círculos, porque o container está de pé e saudável.
 *
 * ECONNRESET/EPIPE aqui é a assinatura de um `wslrelay.exe` órfão no Windows: o
 * Docker roda dentro da WSL, o Windows encaminha a porta por um relay, e quando
 * os containers são recriados sem derrubar a WSL o relay antigo continua
 * escutando 5433. Ele aceita a conexão TCP — por isso `netstat` jura que a
 * porta está viva — e reseta no primeiro byte, porque não tem para onde
 * encaminhar. De dentro da WSL o mesmo banco responde normalmente.
 */
const RELAY_CODES = new Set(['ECONNRESET', 'EPIPE']);

let pool: pg.Pool | null = null;
let state: DbState = 'connecting';
let retry: NodeJS.Timeout | null = null;
let notify: ((state: DbState) => void) | null = null;

/** Esconde a senha na hora de imprimir o endereço no log. */
function mask(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}

function setState(next: DbState): void {
  if (state === next) return;
  state = next;
  notify?.(next);
}

async function attempt(): Promise<DbState> {
  const { url, source } = config.database;

  if (!pool) {
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3000 });
    // Sem este ouvinte, um Postgres que cai derruba o processo inteiro.
    pool.on('error', (error) => console.error('[db] erro no pool:', error.message));
  }

  try {
    // Três perguntas: o banco atende? Ele tem as tabelas que o Tree precisa? E o
    // Tree já é por projeto? A última importa porque as funções de busca passaram
    // a receber o caminho do projeto — num banco sem a 002 elas nem existem com
    // essa assinatura, e o erro que aparece ("function does not exist") não diz a
    // ninguém que o conserto é rodar uma migração.
    const { rows } = await pool.query<{ exists: string | null; scoped: string | null }>(
      `SELECT to_regclass('public.subjects')::text AS exists,
              to_regclass('public.subjects_project_slug_idx')::text AS scoped`,
    );
    if (!rows[0]?.exists) {
      console.warn(`[db] conectado em ${mask(url)}, mas a tabela "subjects" não existe.`);
      console.warn('[db] O banco foi criado antes do Tree de dois níveis. Aplique a migração:');
      console.warn('[db]   docker exec -i ia_coder_postgres psql -U iacoder -d iacoder < db/migrations/001_tree_dois_niveis.sql');
      setState('schema-missing');
      return state;
    }
    if (!rows[0]?.scoped) {
      console.warn(`[db] conectado em ${mask(url)}, mas o Tree ainda é global (sem escopo de projeto).`);
      console.warn('[db] Aplique a migração:');
      console.warn('[db]   docker exec -i ia_coder_postgres psql -U iacoder -d iacoder < db/migrations/002_tree_por_projeto.sql');
      setState('schema-missing');
      return state;
    }
    if (state !== 'ok') console.log(`[db] conectado em ${mask(url)} (via ${source})`);
    setState('ok');
    return state;
  } catch (error) {
    const message = (error as Error).message;
    const code = (error as NodeJS.ErrnoException).code ?? '';
    const relay = RELAY_CODES.has(code);
    const next: DbState = relay ? 'relay-broken' : 'unreachable';

    if (state !== next) {
      if (relay) {
        console.warn(`[db] ${mask(url)} aceitou a conexão e derrubou (${code}).`);
        console.warn('[db] O container está de pé — quem quebrou foi o encaminhamento de porta da WSL.');
        console.warn('[db] Conserto: no PowerShell, `wsl --shutdown`; depois reabra a WSL e `docker compose up -d`.');
      } else {
        console.warn(`[db] não respondeu em ${mask(url)} (via ${source}): ${message}`);
        console.warn('[db] Tree desativado. Vou continuar tentando a cada 10s — não precisa reiniciar.');
      }
    }
    setState(next);
    return state;
  }
}

/**
 * Conecta e **continua tentando**.
 *
 * O caso comum é subir o servidor antes do `docker compose up -d`. Antes disso
 * aqui, a primeira falha desligava o Tree para sempre e só um reinício
 * resolvia — o que era irritante e, pior, invisível.
 */
export async function initDb(onChange?: (state: DbState) => void): Promise<DbState> {
  notify = onChange ?? null;
  const first = await attempt();

  if (retry) clearInterval(retry);
  retry = setInterval(() => {
    if (state === 'ok') return;
    void attempt();
  }, 10_000);
  // Um timer de reconexão não deve segurar o processo vivo no encerramento.
  retry.unref?.();

  return first;
}

export const dbState = (): DbState => state;
export const dbReady = (): boolean => state === 'ok';

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!pool || state !== 'ok') return [];
  try {
    const result = await pool.query<T>(text, params);
    return result.rows;
  } catch (error) {
    console.error('[db] consulta falhou:', (error as Error).message);
    // Pode ter caído entre uma consulta e outra: reavalia sem derrubar nada.
    void attempt();
    throw error;
  }
}

/** Uma consulta amarrada a uma conexão específica — a da transação em curso. */
export type TxQuery = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;

/**
 * Roda várias escritas como uma coisa só.
 *
 * `query()` pega uma conexão qualquer do pool a cada chamada, sem `BEGIN`: uma
 * sequência de INSERTs que morre no meio deixa metade gravada. Aqui o mesmo
 * client atende tudo, e ou entra tudo ou não entra nada.
 */
export async function withTransaction<T>(run: (tx: TxQuery) => Promise<T>): Promise<T> {
  if (!pool || state !== 'ok') throw new Error('o banco não está disponível');
  const client = await pool.connect();
  const tx: TxQuery = <R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<R[]> => client.query<R>(text, params).then((result) => result.rows);

  try {
    await client.query('BEGIN');
    const result = await run(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // A conexão pode já ter morrido — desfazer é a intenção, não uma garantia.
    try {
      await client.query('ROLLBACK');
    } catch {
      /* conexão perdida: o Postgres desfaz sozinho ao encerrar a sessão */
    }
    console.error('[db] transação desfeita:', (error as Error).message);
    void attempt();
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (retry) clearInterval(retry);
  retry = null;
  await pool?.end();
  pool = null;
  setState('connecting');
}

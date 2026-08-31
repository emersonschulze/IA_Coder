import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export type DbState =
  | 'connecting'      // tentando pela primeira vez
  | 'ok'              // conectado e com o esquema certo
  | 'unreachable'     // ninguém atendeu no endereço
  | 'schema-missing'; // banco de pé, mas sem as tabelas do Tree

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
    // Duas perguntas: o banco atende? E ele tem as tabelas que o Tree precisa?
    const { rows } = await pool.query<{ exists: string | null }>(
      `SELECT to_regclass('public.subjects')::text AS exists`,
    );
    if (!rows[0]?.exists) {
      console.warn(`[db] conectado em ${mask(url)}, mas a tabela "subjects" não existe.`);
      console.warn('[db] O banco foi criado antes do Tree de dois níveis. Aplique a migração:');
      console.warn('[db]   docker exec -i ia_coder_postgres psql -U iacoder -d iacoder < db/migrations/001_tree_dois_niveis.sql');
      setState('schema-missing');
      return state;
    }
    if (state !== 'ok') console.log(`[db] conectado em ${mask(url)} (via ${source})`);
    setState('ok');
    return state;
  } catch (error) {
    const message = (error as Error).message;
    if (state !== 'unreachable') {
      console.warn(`[db] não respondeu em ${mask(url)} (via ${source}): ${message}`);
      console.warn('[db] Tree desativado. Vou continuar tentando a cada 10s — não precisa reiniciar.');
    }
    setState('unreachable');
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

export async function closeDb(): Promise<void> {
  if (retry) clearInterval(retry);
  retry = null;
  await pool?.end();
  pool = null;
  setState('connecting');
}

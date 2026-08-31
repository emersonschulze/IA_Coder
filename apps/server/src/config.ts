import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Raiz do repositório IA_Coder (apps/server/src → ../../..). */
export const repoRoot = resolve(here, '..', '..', '..');

loadEnv({ path: resolve(repoRoot, '.env') });

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Endereço do Postgres.
 *
 * Se `DATABASE_URL` existir, mandamos nela. Senão montamos a partir das MESMAS
 * variáveis que o docker-compose.yml usa, com os mesmos padrões — assim o
 * servidor acha o banco sem você precisar declarar a mesma coisa duas vezes.
 */
function resolveDatabaseUrl(): { url: string; source: 'DATABASE_URL' | 'docker-compose' } {
  const explicit = process.env.DATABASE_URL?.trim();
  if (explicit) return { url: explicit, source: 'DATABASE_URL' };

  const user = process.env.POSTGRES_USER ?? 'iacoder';
  const password = process.env.POSTGRES_PASSWORD ?? 'iacoder';
  const database = process.env.POSTGRES_DB ?? 'iacoder';
  const host = process.env.POSTGRES_HOST ?? 'localhost';
  // 5433 no host é o padrão do nosso compose, para não brigar com um Postgres
  // já instalado no Windows.
  const port = process.env.POSTGRES_PORT ?? '5433';

  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return { url: `postgresql://${credentials}@${host}:${port}/${database}`, source: 'docker-compose' };
}

const database = resolveDatabaseUrl();

export const config = {
  port: int(process.env.SERVER_PORT, 8787),
  database,
  host: process.env.SERVER_HOST ?? '127.0.0.1',

  /** Onde as preferências ficam gravadas (caminho do projeto, recentes). */
  prefsFile: resolve(repoRoot, 'workspace', 'prefs.json'),
  artifactsDir: resolve(repoRoot, process.env.ARTIFACTS_DIR ?? 'workspace/artifacts'),

  /** Projeto usado enquanto o usuário não escolheu nenhum. */
  defaultProjectPath: process.env.DEFAULT_PROJECT_PATH ?? repoRoot,

  claude: {
    bin: process.env.CLAUDE_BIN ?? 'claude',
    /**
     * acceptEdits: aceita edições de arquivo sem perguntar, mas continua barrando
     * o resto. Em modo -p não existe prompt de permissão — o que não é aceito,
     * falha. Se quiser soltar tudo (só faz sentido em máquina sua), use
     * bypassPermissions.
     */
    permissionMode: process.env.CLAUDE_PERMISSION_MODE ?? 'acceptEdits',
    model: process.env.CLAUDE_MODEL,
    /** Sobe o processo assim que a primeira aba conecta. */
    autoStart: process.env.CLAUDE_AUTOSTART !== 'false',
  },

  shell: {
    /** No Windows é o PowerShell; fora dele, bash — útil para testes. */
    bin:
      process.env.SHELL_BIN ??
      (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'),
    autoStart: process.env.SHELL_AUTOSTART !== 'false',
  },
} as const;

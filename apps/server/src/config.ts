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

  const { host, port, user, password, name } = databaseParts;
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return { url: `postgresql://${credentials}@${host}:${port}/${name}`, source: 'docker-compose' };
}

/**
 * As mesmas peças soltas — host/porta/usuário/senha/nome — que a tela de
 * Configurações edita. Ficam expostas à parte porque `settings.ts` usa isto
 * como valor padrão antes de existir um `workspace/settings.json`.
 */
export const databaseParts = {
  host: process.env.POSTGRES_HOST ?? 'localhost',
  // 5433 no host é o padrão do nosso compose, para não brigar com um Postgres
  // já instalado no Windows.
  port: int(process.env.POSTGRES_PORT, 5433),
  user: process.env.POSTGRES_USER ?? 'iacoder',
  password: process.env.POSTGRES_PASSWORD ?? 'iacoder',
  name: process.env.POSTGRES_DB ?? 'iacoder',
};

export const redisParts = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: int(process.env.REDIS_PORT, 6379),
  password: process.env.REDIS_PASSWORD ?? '',
};

export const voiceParts = {
  whisperUrl: process.env.WHISPER_URL ?? 'http://localhost:9000',
  piperUrl: process.env.PIPER_URL ?? 'http://localhost:5002',
  piperVoice: process.env.PIPER_VOICE ?? 'pt_BR-faber-medium',
  wakeWord: process.env.VOICE_WAKE_WORD ?? 'ia coder',
};

const database = resolveDatabaseUrl();

export const config = {
  port: int(process.env.SERVER_PORT, 8787),
  database,
  host: process.env.SERVER_HOST ?? '127.0.0.1',
  /**
   * Origens extras que podem abrir o WebSocket, separadas por vírgula.
   *
   * O padrão já aceita qualquer endereço local (o Vite pode subir em 5174 se a
   * 5173 estiver ocupada). Isto existe para quem serve a interface de outro
   * lugar — e é a única forma de afrouxar a checagem, que sem ela deixaria
   * qualquer site aberto no seu navegador pilotar o agente.
   */
  allowedOrigins: (process.env.SERVER_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  /** Onde as preferências ficam gravadas (caminho do projeto, recentes). */
  prefsFile: resolve(repoRoot, 'workspace', 'prefs.json'),
  /** Onde a tela de Configurações grava banco/Redis/voz — sobrepõe o `.env`. */
  settingsFile: resolve(repoRoot, 'workspace', 'settings.json'),
  artifactsDir: resolve(repoRoot, process.env.ARTIFACTS_DIR ?? 'workspace/artifacts'),

  /** Projeto usado enquanto o usuário não escolheu nenhum. */
  defaultProjectPath: process.env.DEFAULT_PROJECT_PATH ?? repoRoot,

  claude: {
    bin: process.env.CLAUDE_BIN ?? 'claude',
    /**
     * Em modo -p não existe prompt de permissão: o que não é aprovado de
     * antemão, falha calado. Por isso o padrão é `auto`, e não `acceptEdits`.
     *
     * `acceptEdits` libera edição de arquivo e mais nada — em particular, NÃO
     * libera ferramenta de MCP. Era isso que fazia o Jira "não carregar": o
     * servidor Atlassian estava conectado e autenticado, a ferramenta existia,
     * e a chamada morria com `permission_denied`. Nem `--allowedTools` nem
     * `permissions.allow` no settings valem para MCP (testado no CLI 2.1.251);
     * só o modo resolve. `auto` aprova o que é de baixo risco — leitura,
     * edição, MCP — e continua barrando o que é perigoso de verdade.
     *
     * Quem quiser soltar tudo (só faz sentido em máquina sua) usa
     * `bypassPermissions`. Modos que não alcançam MCP: `acceptEdits`,
     * `dontAsk`, `manual`, `plan`.
     */
    permissionMode: process.env.CLAUDE_PERMISSION_MODE ?? 'auto',
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

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);

export interface AuthState {
  loggedIn: boolean;
  /** oauth_token, api_key… */
  method?: string;
  /** Quando a última verificação aconteceu. */
  checkedAt: number;
  error?: string;
  /**
   * Motivo, quando não está logado. `expired` vem de um 401 de verdade — vale
   * mais que a opinião do CLI (veja `checkAuth`).
   */
  reason?: 'expired' | 'missing';
}

/**
 * Frases que o Claude Code devolve quando a credencial morreu.
 *
 * Em modo -p não existe tela de login: o turno simplesmente falha com um texto.
 * Reconhecer esse texto é o que transforma "deu erro" em "sua sessão expirou,
 * clique aqui para entrar de novo".
 */
const AUTH_FAILURE = [
  /401/,
  /oauth/i,
  /re-?authenticate/i,
  /failed to authenticate/i,
  /invalid api key/i,
  /authentication_error/i,
  /not logged in/i,
];

export const looksLikeAuthFailure = (text: string): boolean =>
  Boolean(text) && AUTH_FAILURE.some((pattern) => pattern.test(text));

/**
 * Pergunta ao CLI sobre a credencial.
 *
 * Atenção ao que este comando realmente responde: `claude auth status` diz que
 * existe uma credencial guardada — **não** que ela ainda é aceita pela API. Um
 * token vencido continua aparecendo como `loggedIn: true`. Por isso um 401 vindo
 * de uma chamada real tem a palavra final, e é ele que marca a sessão como
 * expirada (`markExpired`), não este comando.
 */
export async function checkAuth(): Promise<AuthState> {
  const args = ['auth', 'status', '--json'];
  try {
    const { stdout } = await run(
      process.platform === 'win32' ? 'cmd.exe' : config.claude.bin,
      process.platform === 'win32'
        ? ['/d', '/s', '/c', `${config.claude.bin} ${args.join(' ')}`]
        : args,
      { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 64 },
    );
    const parsed = JSON.parse(stdout.trim()) as { loggedIn?: boolean; authMethod?: string };
    return {
      loggedIn: Boolean(parsed.loggedIn),
      method: parsed.authMethod,
      checkedAt: Date.now(),
    };
  } catch (error) {
    return {
      loggedIn: false,
      checkedAt: Date.now(),
      error: (error as Error).message,
    };
  }
}

/**
 * Abre uma janela de terminal VISÍVEL rodando `claude auth login`.
 *
 * É a única parte da ferramenta que aparece de propósito: o login é OAuth, abre
 * o navegador e precisa de você. O shell que roda por trás dos panos não serve
 * aqui — ele é escondido e não tem para onde mostrar o prompt.
 */
/**
 * Faz o login pelo PowerShell que já está aberto na pasta do projeto.
 *
 * É o caminho preferido: não abre janela nenhuma. O `claude auth login` imprime
 * o endereço de autorização e abre o navegador; nós repassamos cada linha para
 * a interface, então o link aparece no próprio popup, clicável.
 */
export async function loginViaShell(
  shell: { run: (command: string) => Promise<{ output: string; exitCode: number }> },
  onLine: (line: string) => void,
  listen: (handler: (line: string) => void) => () => void,
): Promise<{ ok: boolean; output: string }> {
  const stop = listen(onLine);
  try {
    const result = await shell.run(`${config.claude.bin} auth login --claudeai`);
    return { ok: result.exitCode === 0, output: result.output };
  } finally {
    stop();
  }
}

/** Endereços de autorização que aparecem na saída do login. */
export function extractUrls(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s"'<>]+/g) ?? [])];
}

export function openLoginTerminal(cwd: string): void {
  if (process.platform !== 'win32') {
    throw new Error('Abrir o terminal de login automaticamente só funciona no Windows.');
  }
  // `start ""` com título vazio evita que o cmd trate o programa como título.
  const line = `start "" powershell.exe -NoExit -NoProfile -Command "${config.claude.bin} auth login"`;
  const child = spawn(line, {
    cwd,
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

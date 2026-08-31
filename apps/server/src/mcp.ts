import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import type { McpServer, McpStatus } from './protocol.js';

const run = promisify(execFile);

/**
 * Os servidores MCP que o Claude Code enxerga, e se dá para usar cada um.
 *
 * Duas coisas diferentes derrubam uma ferramenta de MCP aqui dentro, e confundir
 * as duas custou tempo:
 *
 * 1. **Falta de credencial** — o servidor aparece como `Needs authentication`.
 *    Resolve-se com `claude mcp login <nome>`, que é OAuth e precisa de você.
 *    É o que este arquivo faz.
 * 2. **Falta de permissão** — o servidor está conectado, a ferramenta existe, e
 *    mesmo assim a chamada morre com `permission_denied`. Isso não é login: é o
 *    `--permission-mode` do processo. Veja o comentário em `config.ts`.
 *
 * O sintoma na tela é o mesmo ("o Jira não carrega"), a cura não. Por isso o
 * estado de cada servidor viaja até a interface: ela consegue dizer qual dos
 * dois é.
 */

/** Como o Claude Code monta o prefixo das ferramentas a partir do nome do servidor. */
export const slugOf = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_');

/** `mcp__claude_ai_Datadog__search_logs` → `claude_ai_Datadog`. */
export function serverSlugOfTool(tool: string): string | null {
  const match = /^mcp__(.+?)__/.exec(tool);
  return match ? match[1] : null;
}

/**
 * De qual servidor é esta ferramenta?
 *
 * A lista conhecida vem primeiro porque o nome do servidor pode conter o
 * próprio separador: "Junto  Seguros" (dois espaços) vira `Junto__Seguros`, e
 * aí o corte pelo primeiro `__` inventa um servidor que não existe. Casando
 * contra quem realmente está configurado — do slug mais longo para o mais
 * curto, senão um prefixo comum rouba o outro — isso não acontece.
 */
export function serverOfTool(tool: string, servers: McpServer[]): McpServer | null {
  const found = [...servers]
    .sort((a, b) => b.slug.length - a.slug.length)
    .find((server) => tool.startsWith(`mcp__${server.slug}__`));
  return found ?? null;
}

function statusOf(text: string): McpStatus {
  if (/needs? authentication/i.test(text)) return 'needs-auth';
  if (/pending/i.test(text)) return 'pending';
  if (/connected/i.test(text)) return 'connected';
  return 'failed';
}

/**
 * Lê a saída do `claude mcp list`.
 *
 * O formato é uma linha por servidor, e ele é mais traiçoeiro do que parece:
 * o NOME pode conter " - " (`claude.ai Junto Seguros - Garantia`) e o ALVO pode
 * conter ":" (`node C:\...\index.mjs`). Então o corte é pelo PRIMEIRO ": " para
 * separar o nome, e pelo ÚLTIMO " - " do resto para separar o status.
 */
export function parseMcpList(output: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^checking mcp server health/i.test(line)) continue;

    const colon = line.indexOf(': ');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const rest = line.slice(colon + 2).trim();

    const dash = rest.lastIndexOf(' - ');
    if (dash < 0) continue;

    const target = rest.slice(0, dash).trim();
    const label = rest.slice(dash + 3).replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (!name || !target) continue;

    servers.push({ name, slug: slugOf(name), target, status: statusOf(label), label });
  }
  return servers;
}

/**
 * Pergunta ao CLI quem está configurado e quem responde.
 *
 * Não é barato: ele faz health check em cada servidor, e com dezesseis
 * conectores isso passa de dez segundos. Por isso roda no boot, quando você
 * pede, e depois de um login — nunca no pulso de um minuto.
 */
export async function listMcpServers(cwd: string): Promise<McpServer[]> {
  const args = ['mcp', 'list'];
  const { stdout, stderr } = await run(
    process.platform === 'win32' ? 'cmd.exe' : config.claude.bin,
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `${config.claude.bin} ${args.join(' ')}`]
      : args,
    { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 256 },
  );
  return parseMcpList(`${stdout}\n${stderr}`);
}

/**
 * Faz o login de um servidor MCP pelo PowerShell que já está aberto.
 *
 * Mesmo caminho do `claude auth login` (veja `auth.ts`): o comando imprime o
 * endereço de autorização e abre o navegador; nós repassamos cada linha, e o
 * popup mostra o link clicável enquanto você aprova.
 */
export async function loginMcpViaShell(
  name: string,
  shell: { run: (command: string) => Promise<{ output: string; exitCode: number }> },
  onLine: (line: string) => void,
  listen: (handler: (line: string) => void) => () => void,
): Promise<{ ok: boolean; output: string }> {
  const stop = listen(onLine);
  try {
    const result = await shell.run(`${config.claude.bin} mcp login "${name.replace(/"/g, '`"')}"`);
    return { ok: result.exitCode === 0, output: result.output };
  } finally {
    stop();
  }
}

/** A saída de emergência: uma janela de terminal visível, quando o shell não serve. */
export function openMcpLoginTerminal(name: string, cwd: string): void {
  if (process.platform !== 'win32') {
    throw new Error('Abrir o terminal de login automaticamente só funciona no Windows.');
  }
  const inner = `${config.claude.bin} mcp login '${name.replace(/'/g, "''")}'`;
  const line = `start "" powershell.exe -NoExit -NoProfile -Command "${inner}"`;
  const child = spawn(line, { cwd, shell: true, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

/**
 * Modos de permissão que alcançam ferramenta de MCP em sessão não interativa.
 *
 * Medido no CLI 2.1.251, não deduzido: com `acceptEdits` a chamada volta
 * `permission_denied`, e nem `--allowedTools mcp__servidor`, nem
 * `mcp__servidor__ferramenta`, nem `permissions.allow` no `--settings` mudam
 * isso. Só o modo.
 */
const MCP_CAPABLE_MODES = ['auto', 'bypassPermissions'];

export const permissionModeReachesMcp = (mode: string): boolean =>
  MCP_CAPABLE_MODES.includes(mode);

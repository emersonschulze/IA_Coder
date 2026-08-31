import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * O consumo REAL da conta — o mesmo número que `/usage` mostra dentro do
 * Claude Code, ou a barra "Sessão atual" do app. Nada de contar token que o
 * `-p` gastou nesta sessão: aquilo é o gasto daqui, não o limite da conta.
 */
export interface AccountUsage {
  /** Janela de 5 horas — 0..100. */
  fiveHourPct: number;
  fiveHourResetsAt: number | null;
  /** Janela semanal (todos os modelos) — 0..100. */
  weekPct: number;
  weekResetsAt: number | null;
}

/**
 * Onde o Claude Code guarda a credencial OAuth.
 *
 * No Windows e no Linux é um JSON em texto puro; no Mac ele migra para o
 * Keychain e apaga o arquivo — por isso este caminho só funciona nos dois
 * primeiros (que é o nosso caso: o servidor roda no Windows do usuário).
 */
function credentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

async function readAccessToken(): Promise<string | null> {
  try {
    const raw = await readFile(credentialsPath(), 'utf8');
    const data = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return data.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Não existe documentação oficial para isto — é o endpoint que o próprio
 * Claude Code chama por trás do `/usage`, descoberto e usado por várias
 * ferramentas da comunidade (statuslines, menu bars). Pode mudar sem aviso;
 * por isso qualquer coisa fora do esperado vira `null` em vez de derrubar o
 * painel — quem chama mantém o último número bom que tinha.
 */
export async function fetchAccountUsage(): Promise<AccountUsage | null> {
  const token = await readAccessToken();
  if (!token) return null;

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      five_hour?: { utilization?: number; resets_at?: string | null };
      seven_day?: { utilization?: number; resets_at?: string | null };
    };
    const five = data.five_hour;
    const week = data.seven_day;
    if (!five || !week) return null;

    return {
      fiveHourPct: Math.round(Number(five.utilization ?? 0)),
      fiveHourResetsAt: toMs(five.resets_at),
      weekPct: Math.round(Number(week.utilization ?? 0)),
      weekResetsAt: toMs(week.resets_at),
    };
  } catch {
    return null;
  }
}

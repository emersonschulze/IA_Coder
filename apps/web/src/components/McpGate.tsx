import { useEffect, useRef } from 'react';
import { useSession } from '@/store/useSession';
import type { McpServer } from '@/types/domain';
import styles from './McpGate.module.css';

interface Props {
  /** Faz o login de um servidor pelo PowerShell que já está aberto. */
  onLogin: (server: string) => void;
  /** Abre uma janela de terminal visível, quando o caminho de cima não serve. */
  onLoginWindow: (server: string) => void;
  onRecheck: () => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<McpServer['status'], string> = {
  connected: 'conectado',
  'needs-auth': 'sem login',
  pending: 'aprovando',
  failed: 'fora do ar',
};

/** Quem precisa de você primeiro fica em cima. */
const ORDEM: Record<McpServer['status'], number> = {
  'needs-auth': 0,
  failed: 1,
  pending: 2,
  connected: 3,
};

/**
 * Os servidores MCP, e o que fazer com cada um.
 *
 * Existe porque "o Jira não carrega" tem duas causas que se parecem na tela e
 * não se parecem em nada no conserto:
 *
 * - **Sem credencial** — o servidor pede OAuth. É o caso do popup: o
 *   `claude mcp login` roda no PowerShell que já está aberto, o endereço de
 *   autorização aparece aqui clicável, e depois de aprovar o agente reinicia
 *   sozinho com a credencial nova. Mesmo caminho do login do próprio Claude.
 * - **Sem permissão** — o servidor está conectado e autenticado, e a chamada
 *   morre assim mesmo porque o processo roda em modo não interativo com um
 *   `--permission-mode` que não alcança MCP. Aqui login nenhum resolve, e o
 *   aviso no topo diz isso com todas as letras em vez de deixar você tentando
 *   entrar de novo num servidor onde já está dentro.
 *
 * Ele abre sozinho quando uma ferramenta é barrada de verdade — não a cada
 * resposta, e não como portão: dá para fechar e continuar trabalhando, porque
 * quase sempre o servidor que faltou não é o que você precisa agora.
 */
export function McpGate({ onLogin, onLoginWindow, onRecheck, onClose }: Props) {
  const mcp = useSession((state) => state.mcp);
  const login = useSession((state) => state.mcpLogin);
  const console_ = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = console_.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [login.lines.length]);

  // Esc fecha, como em qualquer diálogo.
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [onClose]);

  if (!mcp) return null;

  const servers = [...mcp.servers].sort(
    (a, b) => ORDEM[a.status] - ORDEM[b.status] || a.name.localeCompare(b.name, 'pt-BR'),
  );
  const semLogin = servers.filter((server) => server.status === 'needs-auth').length;
  const conectados = servers.filter((server) => server.status === 'connected').length;
  const bloqueio = mcp.blocked ?? null;
  const started = login.lines.length > 0 || login.running;

  return (
    <div className={styles.overlay} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className={styles.dialog} role="dialog" aria-label="Servidores MCP">
        <header className={styles.head}>
          <div className={styles.headText}>
            <span className={styles.badge}>
              MCP · {conectados} de {servers.length} conectado{conectados === 1 ? '' : 's'}
            </span>
            <h2>
              {bloqueio
                ? `O agente tentou usar ${bloqueio.server} e não conseguiu`
                : 'Servidores MCP deste projeto'}
            </h2>
          </div>
          <button type="button" className={styles.close} onClick={onClose} title="Fechar (Esc)">
            ✕
          </button>
        </header>

        {!mcp.reachable && (
          <p className={styles.note}>
            <b>Isto não é login.</b> O agente roda em modo não interativo com{' '}
            <code>--permission-mode {mcp.permissionMode}</code>, e esse modo não alcança ferramenta
            de MCP: mesmo conectado e autenticado, toda chamada volta como “bloqueada”. Ponha{' '}
            <code>CLAUDE_PERMISSION_MODE=auto</code> no <code>.env</code> e reinicie o servidor —{' '}
            <code>auto</code> libera leitura, edição e MCP e continua barrando o que é perigoso.
          </p>
        )}

        {bloqueio?.reason === 'permission' && mcp.reachable && (
          <p className={styles.note}>
            <b>{bloqueio.tool}</b> foi barrada por permissão, não por falta de credencial — é uma
            ferramenta que o modo <code>{mcp.permissionMode}</code> considera arriscada demais para
            aprovar sozinho. Rode esse passo num terminal, ou suba para{' '}
            <code>bypassPermissions</code> se esta máquina for sua.
          </p>
        )}

        {mcp.reachable && semLogin > 0 && !bloqueio && (
          <p className={styles.body}>
            {semLogin} servidor{semLogin === 1 ? '' : 'es'} sem credencial. Clique em{' '}
            <b>entrar</b>: o endereço de autorização aparece aqui e no seu navegador, e depois de
            aprovar o agente reinicia sozinho já enxergando as ferramentas.
          </p>
        )}

        {mcp.error && <p className={styles.error}>{mcp.error}</p>}

        <div className={styles.list}>
          {servers.length === 0 && (
            <p className={styles.empty}>
              {mcp.checking
                ? 'varrendo os servidores…'
                : 'nenhum servidor MCP configurado neste projeto'}
            </p>
          )}
          {servers.map((server) => {
            const destacado = bloqueio?.server === server.name;
            const precisa = server.status === 'needs-auth' || server.status === 'failed';
            const entrando = login.running && login.server === server.name;
            return (
              <div
                key={server.name}
                className={[styles.row, destacado ? styles.rowBlocked : ''].filter(Boolean).join(' ')}
              >
                <div className={styles.rowText}>
                  <div className={styles.name}>{server.name}</div>
                  <div className={styles.target} title={server.target}>
                    {server.target}
                  </div>
                </div>
                <span className={styles.pill} data-status={server.status} title={server.label}>
                  {STATUS_LABEL[server.status]}
                </span>
                {precisa && (
                  <button
                    type="button"
                    className={styles.enter}
                    onClick={() => onLogin(server.name)}
                    disabled={login.running}
                    title={`claude mcp login "${server.name}"`}
                  >
                    {entrando ? '⏳ entrando' : '⌸ entrar'}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {started && (
          <>
            <div className={styles.console} ref={console_}>
              {login.lines.map((line, index) => (
                <div key={`${index}-${line.slice(0, 12)}`}>{line}</div>
              ))}
              {login.running && <div className={styles.blink}>aguardando você aprovar…</div>}
            </div>

            {login.urls.length > 0 && (
              <div className={styles.links}>
                {login.urls.map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer">
                    ↗ {url}
                  </a>
                ))}
              </div>
            )}
          </>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={onRecheck}
            disabled={mcp.checking}
          >
            {mcp.checking ? '⏳ verificando…' : '⟳ Verificar de novo'}
          </button>
          <button type="button" className={styles.ghost} onClick={onClose}>
            Fechar
          </button>
        </div>

        <p className={styles.footnote}>
          Travou?{' '}
          <button
            type="button"
            className={styles.linkish}
            onClick={() => onLoginWindow(login.server ?? servers[0]?.name ?? '')}
            disabled={servers.length === 0}
          >
            abrir o login numa janela do PowerShell
          </button>{' '}
          — ou rode <code>claude mcp login &quot;nome do servidor&quot;</code> em qualquer terminal e
          clique em “verificar de novo”.
        </p>
      </div>
    </div>
  );
}

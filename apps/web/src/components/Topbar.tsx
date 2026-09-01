import { useEffect, useState } from 'react';
import { clock } from '@/lib/format';
import { useSession } from '@/store/useSession';
import styles from './Topbar.module.css';

interface Props {
  onCancel: () => void;
  onOpenProject: () => void;
  onRestart: () => void;
  ttsEnabled: boolean;
  onToggleTts: () => void;
  /** Modo conversa: fica aqui em cima, junto do resto do que liga e desliga. */
  conversationActive: boolean;
  onToggleConversation: () => void;
  /** Abre a lista de servidores MCP — quem está de pé e quem precisa de login. */
  onOpenMcp: () => void;
}

/** Como cada estado dos processos aparece na barra. */
const RUNTIME_LABEL: Record<string, string> = {
  stopped: 'PARADO',
  starting: 'ABRINDO',
  ready: 'PRONTO',
  thinking: 'PENSANDO',
  error: 'FALHOU',
};

const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'CONECTANDO',
  open: 'ONLINE',
  reconnecting: 'RECONECTANDO',
  closed: 'OFFLINE',
};

export function Topbar({
  onCancel,
  onOpenProject,
  onRestart,
  ttsEnabled,
  onToggleTts,
  conversationActive,
  onToggleConversation,
  onOpenMcp,
}: Props) {
  const connection = useSession((state) => state.connection);
  const detail = useSession((state) => state.connectionDetail);
  const session = useSession((state) => state.session);
  const workflow = useSession((state) => state.workflow);
  const thinking = useSession((state) => state.conversation.thinking);
  const project = useSession((state) => state.project);
  const mcp = useSession((state) => state.mcp);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = session?.startedAt ?? Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => window.clearInterval(id);
  }, [session?.startedAt]);

  const ledClass =
    connection === 'open' ? styles.led : connection === 'closed' ? styles.ledDown : styles.ledWarn;

  const claudeStatus = project?.claude.status ?? 'stopped';
  const claudeLed =
    claudeStatus === 'ready' ? styles.led
    : claudeStatus === 'error' ? styles.ledDown
    : claudeStatus === 'stopped' ? styles.ledDown
    : styles.ledWarn;

  /*
   * O chip de MCP conta a fração que INTERESSA: quantos servidores dá para usar
   * de verdade. Um número só ("16 servidores") esconderia justamente o caso que
   * te trouxe aqui — a dúzia que está configurada e não responde.
   */
  const mcpServers = mcp?.servers ?? [];
  const mcpOk = mcpServers.filter((server) => server.status === 'connected').length;
  const mcpPendentes = mcpServers.filter((server) => server.status === 'needs-auth').length;
  const mcpLed =
    mcp?.reachable === false || mcp?.blocked ? styles.ledDown
    : mcp?.checking || mcpPendentes > 0 ? styles.ledWarn
    : mcpOk > 0 ? styles.led
    : styles.ledWarn;
  const mcpTitle =
    mcp?.reachable === false
      ? `o modo de permissão "${mcp.permissionMode}" não alcança ferramenta de MCP — clique para ver`
      : mcpPendentes > 0
        ? `${mcpPendentes} servidor(es) sem credencial — clique para entrar`
        : 'servidores MCP deste projeto';

  return (
    <header className={styles.topbar}>
      <div className={styles.brand}>
        <i className={styles.dot} />
        IA_CODER <small>// ORQUESTRADOR DE AGENTES</small>
      </div>

      <div className={styles.metrics}>
        <div className={styles.chip} title={detail}>
          <i className={ledClass} />
          LINK <b>{CONNECTION_LABEL[connection] ?? connection.toUpperCase()}</b>
        </div>
        <button
          type="button"
          className={[styles.chip, styles.chipButton].join(' ')}
          onClick={onOpenProject}
          title={project?.path ?? 'escolher a pasta do projeto'}
        >
          <span className={styles.folder}>▣</span>
          PROJETO <b>{project?.name ?? '—'}</b>
        </button>
        <div className={styles.chip} title={project?.claude.error ?? project?.claude.model ?? ''}>
          <i className={claudeLed} />
          CLAUDE <b>{RUNTIME_LABEL[claudeStatus] ?? claudeStatus}</b>
        </div>
        <div className={styles.chip} title={project?.shell.error ?? ''}>
          {session?.runtime ?? 'SHELL'} <b>{RUNTIME_LABEL[project?.shell.status ?? 'stopped']}</b>
        </div>
        <button
          type="button"
          className={[styles.chip, styles.chipButton].join(' ')}
          onClick={onOpenMcp}
          title={mcpTitle}
        >
          <i className={mcpLed} />
          MCP <b>{mcp?.checking && mcpServers.length === 0 ? '…' : `${mcpOk}/${mcpServers.length}`}</b>
        </button>
        <div className={styles.chip}>
          SESSÃO <b>{clock(elapsed)}</b>
        </div>
        <button
          type="button"
          className={[styles.action, conversationActive ? styles.actionOn : ''].filter(Boolean).join(' ')}
          onClick={onToggleConversation}
          title="Modo conversa: fale à vontade, 1,5s de silêncio envia"
        >
          {conversationActive ? '◉ CONVERSA ON' : '◎ CONVERSA'}
        </button>
        <button
          type="button"
          className={[styles.action, ttsEnabled ? styles.actionOn : ''].filter(Boolean).join(' ')}
          onClick={onToggleTts}
          title="Resposta falada"
        >
          {ttsEnabled ? '🔊 VOZ ON' : '🔇 VOZ OFF'}
        </button>
        <button type="button" className={styles.action} onClick={onRestart} title="Reabrir shell e Claude na pasta do projeto">
          ⟳
        </button>
        {/*
          Também vale enquanto ele só "pensa".
          Antes o botão exigia um workflow rodando — e o caso em que você mais
          quer abortar é justamente o outro: o agente lendo o projeto para
          responder, sem ter aberto workflow nenhum ainda. Ali o botão ficava
          cinza e não havia como parar.
        */}
        <button
          type="button"
          className={[styles.action, styles.actionDanger].join(' ')}
          onClick={onCancel}
          disabled={workflow?.state !== 'running' && !thinking}
          title="Para o agente e o terminal agora"
        >
          ■ ABORTAR
        </button>
      </div>
    </header>
  );
}

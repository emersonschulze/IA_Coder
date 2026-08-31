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
}: Props) {
  const connection = useSession((state) => state.connection);
  const detail = useSession((state) => state.connectionDetail);
  const session = useSession((state) => state.session);
  const workflow = useSession((state) => state.workflow);
  const project = useSession((state) => state.project);
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
        <button
          type="button"
          className={[styles.action, styles.actionDanger].join(' ')}
          onClick={onCancel}
          disabled={workflow?.state !== 'running'}
        >
          ■ ABORTAR
        </button>
      </div>
    </header>
  );
}

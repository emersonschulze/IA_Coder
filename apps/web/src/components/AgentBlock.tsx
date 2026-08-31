import { useEffect, useRef, type CSSProperties } from 'react';
import { useAnchor } from '@/anchors/AnchorContext';
import { hhmmss, initialsOf, pct } from '@/lib/format';
import type { Agent, Block, Skill } from '@/types/domain';
import styles from './Working.module.css';

interface Props {
  block: Block;
  agent: Agent | undefined;
  skill: Skill | undefined;
  position: number;
}

const STATE_LABEL: Record<Block['state'], string> = {
  queued: 'na fila',
  running: 'executando',
  done: 'concluído',
  error: 'erro',
};

const LOG_CLASS = {
  info: '',
  ok: styles.logOk,
  warn: styles.logWarn,
  error: styles.logError,
} as const;

/** Um bloco por agente participante do workflow — o "Agent N fazendo X item" do desenho. */
export function AgentBlock({ block, agent, skill, position }: Props) {
  const anchorRef = useAnchor('block', block.id);
  const logRef = useRef<HTMLDivElement>(null);
  const color = agent?.color ?? '#22d3ee';
  const active = block.state === 'running';

  // O log acompanha a última linha, mas só se o usuário não subiu a rolagem.
  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [block.logs.length]);

  const className = [
    styles.block,
    'dimmable',
    active ? `${styles.blockActive} spotlight` : '',
    block.state === 'done' ? styles.blockDone : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article ref={anchorRef} className={className} style={{ '--c': color } as CSSProperties}>
      <i className={styles.sweep} />

      <header className={styles.blockHead}>
        <div className={styles.blockAvatar}>{initialsOf(agent?.name ?? '??', agent?.initials)}</div>
        <div className={styles.blockTitle}>
          Agent {position} · {agent?.name ?? block.agentId}
          <small className={styles.blockAction}>{block.action || 'aguardando alocação…'}</small>
        </div>
        <div className={styles.blockState}>
          <i className={styles.stateLed} />
          <span>{STATE_LABEL[block.state]}</span>
        </div>
      </header>

      <div className={styles.skillPill}>
        <i className={styles.diamond} />
        <span>{skill ? `skill: ${skill.name} — ${skill.detail.toLowerCase()}` : 'skill não atribuída'}</span>
      </div>

      {block.logs.length > 0 && (
        <div className={styles.log} ref={logRef}>
          {block.logs.map((entry, index) => (
            <div className={styles.logLine} key={`${entry.ts}-${index}`}>
              <span className={styles.logTime}>{hhmmss(entry.ts)}</span>
              <span className={LOG_CLASS[entry.level]}>{entry.text}</span>
            </div>
          ))}
        </div>
      )}

      {block.artifacts.length > 0 && (
        <div className={styles.files}>
          {block.artifacts.map((artifact) => (
            <span
              key={artifact.id}
              className={styles.file}
              title={artifact.href ?? artifact.name}
              onClick={() => artifact.href && window.open(artifact.href, '_blank', 'noopener')}
            >
              ＋ {artifact.name}
            </span>
          ))}
        </div>
      )}

      <div className={styles.blockBar}>
        <i style={{ width: `${pct(block.progress)}%` }} />
      </div>
    </article>
  );
}

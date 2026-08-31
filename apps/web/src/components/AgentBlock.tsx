import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useAnchor } from '@/anchors/AnchorContext';
import { duration, hhmmss, initialsOf, pct } from '@/lib/format';
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
  cancelled: 'interrompido',
};

/** Passou disto sem uma linha nova, a tela para de fingir que está tudo bem. */
const QUIETO_MS = 45_000;

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

  /*
   * Quanto tempo este bloco está nisso.
   *
   * Uma delegação longa — o subagente lendo um serviço inteiro — fica minutos
   * na mesma linha de ação, e sem um relógio correndo isso é indistinguível de
   * travamento. O início vem da primeira linha de log, que é escrita quando ele
   * começa a trabalhar de verdade.
   */
  const desde = block.logs[0]?.ts;
  /*
   * Há quanto tempo ele não dá sinal.
   *
   * O tempo total diz "faz 10 minutos que começou", o que não distingue um
   * comando demorado de um processo morto. O que responde essa pergunta é o
   * silêncio: se a última linha de log tem seis minutos, algo está errado, e a
   * tela precisa dizer isso em vez de fingir normalidade.
   */
  const ultimo = block.logs[block.logs.length - 1]?.ts;
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tique = window.setInterval(() => setAgora(Date.now()), 1000);
    return () => window.clearInterval(tique);
  }, [active]);

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
    block.state === 'cancelled' ? styles.blockCancelled : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article ref={anchorRef} className={className} style={{ '--c': color } as CSSProperties}>
      <i className={styles.sweep} />

      <header className={styles.blockHead}>
        <div className={styles.blockAvatar}>{initialsOf(agent?.name ?? '??', agent?.initials)}</div>
        <div className={styles.blockTitle}>
          {position}. {agent?.name ?? block.agentId}
          <small className={styles.blockAction}>{block.action || 'aguardando alocação…'}</small>
        </div>
        <div className={styles.blockState}>
          <i className={styles.stateLed} />
          <span>{STATE_LABEL[block.state]}</span>
          {active && desde !== undefined && (() => {
            const parado = ultimo === undefined ? 0 : agora - ultimo;
            const quieto = parado > QUIETO_MS;
            return (
              <span className={quieto ? styles.blockStalled : styles.blockElapsed}>
                {quieto
                  ? `sem sinal há ${duration(parado / 1000)}`
                  : duration((agora - desde) / 1000)}
              </span>
            );
          })()}
        </div>
      </header>

      <div className={styles.skillPill}>
        <i className={styles.diamond} />
        <span>{skill ? `skill: ${skill.name} — ${skill.detail.toLowerCase()}` : 'sem skill no momento'}</span>
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

import { useEffect, useRef, type CSSProperties } from 'react';
import { useAnchor } from '@/anchors/AnchorContext';
import { initialsOf, pct } from '@/lib/format';
import type { RefKind } from '@/types/domain';
import styles from './Panels.module.css';

interface EntityCardProps {
  kind: Extract<RefKind, 'agent' | 'skill'>;
  id: string;
  name: string;
  role: string;
  color: string;
  initials?: string;
  active: boolean;
  /** 0..100 — barra fina no rodapé do card. */
  progress?: number;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
}

/**
 * Card de agente ou skill. Publica sua posição no registro de âncoras para que
 * o WireLayer consiga desenhar as setas até ele.
 */
export function EntityCard({
  kind,
  id,
  name,
  role,
  color,
  initials,
  active,
  progress = 0,
  onHoverStart,
  onHoverEnd,
}: EntityCardProps) {
  const anchorRef = useAnchor(kind, id);
  const node = useRef<HTMLElement | null>(null);

  // Mesmo com a lista estável, o card que entrou em execução nunca fica fora
  // de vista — rola o mínimo necessário dentro do próprio painel.
  useEffect(() => {
    if (active) node.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);

  const className = [
    styles.card,
    'dimmable',
    active ? styles.cardActive : styles.cardIdleReady,
    active ? 'spotlight' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      ref={(element) => {
        node.current = element;
        anchorRef(element);
      }}
      className={className}
      style={{ '--c': color } as CSSProperties}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      data-entity={`${kind}:${id}`}
    >
      <div className={styles.avatar}>{initialsOf(name, initials)}</div>
      <div className={styles.cardMeta}>
        <div className={styles.cardName}>{name}</div>
        <div className={styles.cardRole}>{role}</div>
      </div>
      <i className={styles.pulse} />
      <i className={styles.cardBar} style={{ width: `${pct(progress)}%` }} />
    </article>
  );
}

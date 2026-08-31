import { useEffect, useRef, useState } from 'react';
import { useAnchors } from '@/anchors/AnchorContext';
import { arrowTransform, wirePath } from '@/lib/geometry';
import { useSession } from '@/store/useSession';
import type { Link } from '@/types/domain';
import styles from './WireLayer.module.css';

interface Rendered {
  link: Link;
  leaving: boolean;
}

interface Nodes {
  group: SVGGElement | null;
  glow: SVGPathElement | null;
  core: SVGPathElement | null;
  head: SVGPathElement | null;
  comet: SVGCircleElement | null;
  label: SVGTextElement | null;
}

const EXIT_MS = 480;
const ARROW_HEAD = 'M0,0 L-9,-4.2 L-6.6,0 L-9,4.2 Z';

/**
 * Camada global das setas.
 *
 * O servidor diz QUAIS ligações existem agora (`link.activated` / `link.deactivated`);
 * aqui só resolvemos as posições reais dos elementos e desenhamos. As posições são lidas
 * num loop de animação e escritas direto no DOM — nada disso passa pelo estado do React.
 */
export function WireLayer() {
  const links = useSession((state) => (state.links.length > 0 ? state.links : state.previewLinks));
  const agents = useSession((state) => state.agents);
  const skills = useSession((state) => state.skills);
  const { rectOf } = useAnchors();

  const [rendered, setRendered] = useState<Rendered[]>([]);
  const nodes = useRef(new Map<string, Nodes>());
  const timers = useRef(new Map<string, number>());

  /* Entrada e saída: o que sai continua montado por EXIT_MS para dar tempo do fade-out. */
  useEffect(() => {
    setRendered((previous) => {
      const incoming = new Map(links.map((link) => [link.id, link]));
      const kept = previous.map((item) =>
        incoming.has(item.link.id)
          ? { link: incoming.get(item.link.id) as Link, leaving: false }
          : { ...item, leaving: true },
      );
      const fresh = links
        .filter((link) => !previous.some((item) => item.link.id === link.id))
        .map((link) => ({ link, leaving: false }));

      kept.forEach((item) => {
        if (!item.leaving) {
          const timer = timers.current.get(item.link.id);
          if (timer) {
            window.clearTimeout(timer);
            timers.current.delete(item.link.id);
          }
          return;
        }
        if (timers.current.has(item.link.id)) return;
        const timer = window.setTimeout(() => {
          timers.current.delete(item.link.id);
          setRendered((list) => list.filter((entry) => entry.link.id !== item.link.id));
        }, EXIT_MS);
        timers.current.set(item.link.id, timer);
      });

      return [...kept, ...fresh];
    });
  }, [links]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  /* Loop de desenho: só roda enquanto existe seta na tela. */
  useEffect(() => {
    if (rendered.length === 0) return;
    let frame = 0;

    const draw = () => {
      const time = performance.now() / 1000;
      rendered.forEach(({ link }, index) => {
        const parts = nodes.current.get(link.id);
        if (!parts?.core || !parts.group) return;

        const from = rectOf(link.from);
        const to = rectOf(link.to);
        if (!from || !to) {
          parts.group.style.visibility = 'hidden';
          return;
        }
        parts.group.style.visibility = 'visible';

        const d = wirePath(from, to);
        parts.core.setAttribute('d', d);
        parts.glow?.setAttribute('d', d);
        parts.head?.setAttribute('transform', arrowTransform(parts.core));

        if (parts.comet) {
          const length = parts.core.getTotalLength();
          const point = parts.core.getPointAtLength(((time * 0.55 + index * 0.27) % 1) * length);
          parts.comet.setAttribute('cx', String(point.x));
          parts.comet.setAttribute('cy', String(point.y));
        }
        if (parts.label) {
          const middle = parts.core.getPointAtLength(parts.core.getTotalLength() * 0.4);
          parts.label.setAttribute('x', String(middle.x + 7));
          parts.label.setAttribute('y', String(middle.y - 7));
        }
      });
      frame = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(frame);
  }, [rendered, rectOf]);

  const colorOf = (link: Link): string => {
    if (link.color) return link.color;
    if (link.to.kind === 'skill') {
      const skill = skills.find((item) => item.id === link.to.id);
      if (skill) return skill.color;
    }
    const agent = agents.find((item) => item.id === link.from.id);
    return agent?.color ?? '#22d3ee';
  };

  return (
    <svg className={styles.layer} aria-hidden>
      {rendered.map(({ link, leaving }) => {
        const color = colorOf(link);
        return (
          <g
            key={link.id}
            className={[styles.wire, leaving ? '' : styles.wireVisible].filter(Boolean).join(' ')}
            ref={(node) => {
              const current = nodes.current.get(link.id) ?? {
                group: null,
                glow: null,
                core: null,
                head: null,
                comet: null,
                label: null,
              };
              if (node) nodes.current.set(link.id, { ...current, group: node });
              else nodes.current.delete(link.id);
            }}
          >
            <path
              className={styles.glow}
              stroke={color}
              ref={(node) => assign(nodes.current, link.id, 'glow', node)}
            />
            <path
              className={styles.core}
              stroke={color}
              ref={(node) => assign(nodes.current, link.id, 'core', node)}
            />
            <path
              d={ARROW_HEAD}
              fill={color}
              opacity="0.95"
              ref={(node) => assign(nodes.current, link.id, 'head', node)}
            />
            <circle
              r="3"
              fill={color}
              className={styles.comet}
              style={{ color }}
              ref={(node) => assign(nodes.current, link.id, 'comet', node)}
            />
            {link.label && (
              <text
                className={styles.label}
                fill={color}
                ref={(node) => assign(nodes.current, link.id, 'label', node)}
              >
                {link.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function assign<K extends keyof Nodes>(
  map: Map<string, Nodes>,
  id: string,
  key: K,
  node: Nodes[K],
): void {
  const current =
    map.get(id) ?? { group: null, glow: null, core: null, head: null, comet: null, label: null };
  map.set(id, { ...current, [key]: node });
}

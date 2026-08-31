import { useLayoutEffect, useRef } from 'react';

/**
 * Animação FLIP para listas que reordenam.
 *
 * Sem isto, promover o agente ativo para o topo faz os cards "teletransportarem":
 * o olho perde quem foi para onde. Com FLIP, cada card desliza da posição antiga
 * para a nova, e a leitura continua contínua.
 *
 * Medimos a posição de cada filho marcado com `data-flip-key` depois de cada
 * render e comparamos com a medição anterior. A animação roda no elemento
 * embrulho, nunca no card — o card tem transform próprio (o destaque do
 * spotlight) e os dois brigariam.
 */
export function useFlipList<T extends HTMLElement>() {
  const container = useRef<T>(null);
  const previous = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, DOMRect>();

    root.querySelectorAll<HTMLElement>('[data-flip-key]').forEach((node) => {
      const key = node.dataset.flipKey;
      if (!key) return;
      const rect = node.getBoundingClientRect();
      next.set(key, rect);

      const before = previous.current.get(key);
      if (!before || reduced) return;

      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

      node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }],
        { duration: 380, easing: 'cubic-bezier(.2,.9,.25,1)' },
      );
    });

    previous.current = next;
  });

  return container;
}

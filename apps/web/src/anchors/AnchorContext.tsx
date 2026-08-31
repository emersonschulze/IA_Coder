import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { Ref as EntityRef, RefKind } from '@/types/domain';

type AnchorKey = string;
const keyOf = (kind: RefKind, id: string): AnchorKey => `${kind}:${id}`;

interface AnchorRegistry {
  register: (kind: RefKind, id: string) => (node: HTMLElement | null) => void;
  rectOf: (ref: EntityRef) => DOMRect | null;
}

const AnchorContext = createContext<AnchorRegistry | null>(null);

/**
 * Registro de âncoras: cada card/bloco publica seu nó DOM aqui, e o WireLayer
 * consulta as posições na hora de desenhar. Fica fora do estado do React de
 * propósito — posição de elemento muda 60x por segundo e não deve causar render.
 */
export function AnchorProvider({ children }: { children: ReactNode }) {
  const nodes = useRef(new Map<AnchorKey, HTMLElement>());

  const register = useCallback(
    (kind: RefKind, id: string) => (node: HTMLElement | null) => {
      const key = keyOf(kind, id);
      if (node) nodes.current.set(key, node);
      else nodes.current.delete(key);
    },
    [],
  );

  const rectOf = useCallback((ref: EntityRef) => {
    const node = nodes.current.get(keyOf(ref.kind, ref.id));
    return node ? node.getBoundingClientRect() : null;
  }, []);

  const value = useMemo<AnchorRegistry>(() => ({ register, rectOf }), [register, rectOf]);
  return <AnchorContext.Provider value={value}>{children}</AnchorContext.Provider>;
}

export function useAnchors(): AnchorRegistry {
  const ctx = useContext(AnchorContext);
  if (!ctx) throw new Error('useAnchors precisa estar dentro de <AnchorProvider>');
  return ctx;
}

/** Açúcar: `<div ref={useAnchor('agent', agent.id)}>` */
export function useAnchor(kind: RefKind, id: string) {
  const { register } = useAnchors();
  return useMemo(() => register(kind, id), [register, kind, id]);
}

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

  /**
   * Onde o card está — preso à borda do painel dele.
   *
   * Um card rolado para fora continua tendo posição: fica acima ou abaixo do
   * painel, muitas vezes fora da janela. A seta o seguia até lá e "se perdia",
   * atravessando a tela inteira até um ponto invisível. Grampeando o retângulo
   * aos limites do painel, a seta encosta na borda enquanto o card está
   * escondido e volta a acompanhá-lo assim que ele reaparece — sem nenhum
   * tratamento especial no desenho.
   */
  const rectOf = useCallback((ref: EntityRef) => {
    const node = nodes.current.get(keyOf(ref.kind, ref.id));
    if (!node) return null;

    const rect = node.getBoundingClientRect();
    const painel = node.closest('[data-anchor-clip]');
    if (!painel) return rect;

    const limite = painel.getBoundingClientRect();
    const topo = Math.min(Math.max(rect.top, limite.top), limite.bottom);
    const base = Math.max(Math.min(rect.bottom, limite.bottom), limite.top);
    // Altura mínima de 2px: um retângulo achatado ainda tem centro, e é o centro
    // que a seta usa para mirar.
    return new DOMRect(rect.left, topo, rect.width, Math.max(2, base - topo));
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

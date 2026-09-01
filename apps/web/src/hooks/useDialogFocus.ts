import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Leva o teclado junto com o overlay.
 *
 * O diálogo cobria a tela, mas o foco continuava lá atrás — no botão da barra
 * que o abriu. Um Tab então passeava pelos controles do app INVISÍVEIS embaixo
 * do overlay (Talking, Agents, Tree) e um Enter distraído acionava um botão que
 * a pessoa não estava vendo; para chegar no "entrar" era preciso tabular a
 * aplicação inteira.
 *
 * Devolve a `ref` do container do diálogo. O container precisa de
 * `tabIndex={-1}` (para receber foco quando ainda não há controle nenhum
 * dentro — diálogo que abre "carregando…" é o caso comum) e de
 * `aria-modal="true"`.
 *
 * `active` existe porque alguns diálogos ficam montados o tempo todo e só
 * aparecem depois (o AuthGate devolve `null` até a credencial vencer): sem ele
 * o efeito rodaria com o container ainda inexistente e nunca mais.
 */
export function useDialogFocus<T extends HTMLElement>(
  active: boolean,
  autoFocus?: RefObject<HTMLElement | null>,
) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;

    const anterior = document.activeElement as HTMLElement | null;
    (autoFocus?.current ?? node.querySelector<HTMLElement>(FOCUSABLE) ?? node).focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focaveis = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        // `offsetParent` nulo = escondido; tabular para o que não está na tela
        // é o mesmo defeito de novo, só que dentro do diálogo.
        (item) => item.offsetParent !== null,
      );
      if (focaveis.length === 0) {
        event.preventDefault();
        return;
      }
      const primeiro = focaveis[0];
      const ultimo = focaveis[focaveis.length - 1];
      const atual = document.activeElement;
      if (event.shiftKey && (atual === primeiro || atual === node)) {
        event.preventDefault();
        ultimo.focus();
      } else if (!event.shiftKey && atual === ultimo) {
        event.preventDefault();
        primeiro.focus();
      }
    };

    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      // Fechou: o foco volta para quem abriu, não para o começo da página.
      anterior?.focus?.();
    };
  }, [active, autoFocus]);

  return ref;
}

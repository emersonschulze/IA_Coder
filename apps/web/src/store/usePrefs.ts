import { create } from 'zustand';

/** Preferências de visualização. Vivem só no navegador, não no servidor. */
interface PrefsState {
  /** Agentes e skills em execução sobem para o topo da lista. */
  pinActive: boolean;
  setPinActive: (value: boolean) => void;
}

const KEY = 'iacoder.prefs.pinActive';

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
};

export const usePrefs = create<PrefsState>((set) => ({
  // Desligado por padrão: lista estável é mais fácil de ler.
  // Ligue no cadeado do cabeçalho do painel e sinta a diferença.
  pinActive: read(),
  setPinActive: (pinActive) => {
    try {
      localStorage.setItem(KEY, pinActive ? 'on' : 'off');
    } catch {
      /* modo privado: segue sem persistir */
    }
    set({ pinActive });
  },
}));

/** Ativos primeiro, mantendo a ordem relativa original dentro de cada grupo. */
export function pinnedFirst<T>(items: T[], isActive: (item: T) => boolean, enabled: boolean): T[] {
  if (!enabled) return items;
  const active = items.filter(isActive);
  if (active.length === 0 || active.length === items.length) return items;
  return [...active, ...items.filter((item) => !isActive(item))];
}

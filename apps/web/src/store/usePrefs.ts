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
    const guardado = localStorage.getItem(KEY);
    // Ligado por padrão, desligado só se você desligar. O padrão era o contrário
    // quando a lista tinha sete skills escritas à mão; com o catálogo real, são
    // dezenas, e o cartão em uso vive fora da vista — junto com a seta que
    // aponta para ele.
    return guardado === null ? true : guardado === 'on';
  } catch {
    return true;
  }
};

export const usePrefs = create<PrefsState>((set) => ({
  // Ligado por padrão: com dezenas de agentes e skills, o que está acontecendo
  // agora tem de estar visível. Desligue no cadeado do cabeçalho se preferir a
  // lista sempre na mesma ordem.
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

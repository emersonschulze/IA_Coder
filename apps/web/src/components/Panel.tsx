import { forwardRef, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './Panels.module.css';

export interface PanelTab {
  id: string;
  label: string;
  badge?: ReactNode;
}

interface PanelProps {
  /** Título fixo. Ignorado quando `tabs` é passado — aí o cabeçalho vira abas. */
  title?: string;
  badge?: ReactNode;
  /** Abas no lugar do título — ex.: Archives/Status alternando no mesmo painel. */
  tabs?: PanelTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  /** Controle pequeno à direita do título (ex.: fixar ativos no topo). */
  action?: ReactNode;
  /** Mostra a lupa: abre o painel em 80% da tela, por cima do resto. */
  zoomable?: boolean;
  children: ReactNode;
  /** `flex` do painel dentro da coluna. */
  style?: CSSProperties;
  className?: string;
}

export function Panel({
  title,
  badge,
  tabs,
  activeTab,
  onTabChange,
  action,
  zoomable,
  children,
  style,
  className,
}: PanelProps) {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomed(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);

  const panel = (
    <section
      className={[styles.panel, zoomed ? styles.panelZoomed : '', className].filter(Boolean).join(' ')}
      style={zoomed ? undefined : style}
      data-zoomed={zoomed ? 'true' : undefined}
    >
      <header className={styles.head}>
        {tabs ? (
          <div className={styles.tabs} role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === activeTab}
                className={[styles.tab, tab.id === activeTab ? styles.tabOn : ''].filter(Boolean).join(' ')}
                onClick={() => onTabChange?.(tab.id)}
              >
                {tab.label}
                {tab.badge !== undefined && <span className={styles.tabBadge}>{tab.badge}</span>}
              </button>
            ))}
          </div>
        ) : (
          <h2 className={styles.title}>{title}</h2>
        )}
        {!tabs && badge !== undefined && <span className={styles.badge}>{badge}</span>}
        {zoomable && (
          <button
            type="button"
            className={[styles.headAction, zoomed ? styles.headActionOn : ''].filter(Boolean).join(' ')}
            onClick={() => setZoomed((value) => !value)}
            title={zoomed ? 'Voltar ao tamanho normal (Esc)' : 'Abrir em tela grande'}
            aria-pressed={zoomed}
          >
            {zoomed ? '⤡' : '⌕'}
          </button>
        )}
        {action}
      </header>
      {children}
    </section>
  );

  if (!zoomed) return panel;

  /**
   * O painel ampliado vai para o fim do `body`, não para dentro da coluna.
   *
   * Como é um portal do React, os componentes filhos continuam vivos: a
   * conversa não perde a transcrição e o grafo não recomeça do zero. O fundo
   * fica só escurecido, para você continuar vendo o resto do projeto.
   */
  return createPortal(
    <div
      className={styles.zoomOverlay}
      onClick={(event) => event.target === event.currentTarget && setZoomed(false)}
    >
      <div className={styles.zoomFrame}>{panel}</div>
    </div>,
    document.body,
  );
}

export const PanelBody = forwardRef<HTMLDivElement, { children: ReactNode; className?: string }>(
  function PanelBody({ children, className }, ref) {
    return (
      <div ref={ref} className={[styles.body, className].filter(Boolean).join(' ')}>
        {children}
      </div>
    );
  },
);

export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

/**
 * Filtro de uma linha, no topo do painel.
 *
 * Existe porque o catálogo real é grande: são dezenas de skills instaladas por
 * plugin, e rolar oitenta cartões para achar uma é pior do que digitar três
 * letras.
 */
export function PanelSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className={styles.search}>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} title="Limpar">
          ✕
        </button>
      )}
    </div>
  );
}

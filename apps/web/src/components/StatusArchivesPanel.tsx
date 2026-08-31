import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/store/useSession';
import { ArchivesBody } from './ArchivesPanel';
import { Panel, type PanelTab } from './Panel';
import { StatusBody } from './StatusPanel';

type TabId = 'archives' | 'status';

/**
 * Archives fica em cena 3 minutos, Status entra por 20 segundos, e volta —
 * repetindo sozinho. É o painel de arquivos que dá lugar ao status por um
 * instante, não o contrário: os arquivos são o que você quer ver na maior
 * parte do tempo.
 */
const DURATION: Record<TabId, number> = {
  archives: 3 * 60_000,
  status: 20_000,
};

/**
 * Archives e Status fundidos num painel só, alternando sozinhos — libera a
 * altura que o Status ocupava na coluna para o painel de Conversa crescer.
 * Um clique na aba troca na hora e reinicia a contagem a partir dali; solto,
 * ele sempre volta a alternar.
 */
export function StatusArchivesPanel() {
  const archivesCount = useSession((state) => state.archives.length);
  const windowPct = useSession((state) => state.usage.windowPct);
  const [active, setActive] = useState<TabId>('archives');
  const timer = useRef<number>();

  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setActive((current) => (current === 'archives' ? 'status' : 'archives'));
    }, DURATION[active]);
    return () => window.clearTimeout(timer.current);
  }, [active]);

  const tabs: PanelTab[] = [
    { id: 'archives', label: 'Archives', badge: archivesCount },
    { id: 'status', label: 'Status', badge: windowPct !== undefined ? `${Math.round(windowPct)}%` : '—' },
  ];

  return (
    <Panel
      tabs={tabs}
      activeTab={active}
      onTabChange={(id) => setActive(id as TabId)}
      zoomable
      style={{ flex: '0 0 auto', maxHeight: 206 }}
    >
      {active === 'archives' ? <ArchivesBody /> : <StatusBody />}
    </Panel>
  );
}

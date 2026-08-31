import { useCallback, useMemo, useState } from 'react';
import { useSession } from '@/store/useSession';
import { pinnedFirst, usePrefs } from '@/store/usePrefs';
import { useFlipList } from '@/hooks/useFlipList';
import { matches } from '@/lib/format';
import type { Link } from '@/types/domain';
import { EntityCard } from './EntityCard';
import { Panel, PanelBody, PanelEmpty, PanelSearch } from './Panel';
import { PinToggle } from './PinToggle';

/** A partir daqui a lista não se varre com o olho — entra o campo de busca. */
const SEARCHABLE_FROM = 8;

interface Props {
  /** Pergunta ao servidor quais ligações esse agente tem (hover). */
  onInspect?: (agentId: string) => void;
}

export function AgentsPanel({ onInspect }: Props) {
  const agents = useSession((state) => state.agents);
  const blocks = useSession((state) => state.blocks);
  const setPreviewLinks = useSession((state) => state.setPreviewLinks);
  const hasServerLinks = useSession((state) => state.links.length > 0);

  const pinActive = usePrefs((state) => state.pinActive);
  const listRef = useFlipList<HTMLDivElement>();
  const [query, setQuery] = useState('');

  const working = agents.filter((agent) => agent.state === 'working').length;
  const ordered = useMemo(() => {
    const found = agents.filter((agent) => matches(query, agent.name, agent.role, agent.source));
    return pinnedFirst(found, (agent) => agent.state === 'working', pinActive);
  }, [agents, pinActive, query]);

  /**
   * Passar o mouse num agente revela as ligações dele mesmo fora de execução.
   * É só pré-visualização local: se o servidor já está mandando setas, não mexemos.
   */
  const preview = useCallback(
    (agentId: string) => {
      if (hasServerLinks) return;
      onInspect?.(agentId);
      const agent = agents.find((item) => item.id === agentId);
      if (!agent) return;
      const block = blocks.find((item) => item.agentId === agentId);
      const links: Link[] = [];
      if (block) {
        links.push({
          id: `preview:${agentId}:block`,
          from: { kind: 'agent', id: agentId },
          to: { kind: 'block', id: block.id },
          label: 'executa',
          color: agent.color,
        });
      }
      if (agent.skillId) {
        links.push({
          id: `preview:${agentId}:skill`,
          from: { kind: 'agent', id: agentId },
          to: { kind: 'skill', id: agent.skillId },
          label: 'usa',
        });
      }
      setPreviewLinks(links);
    },
    [agents, blocks, hasServerLinks, onInspect, setPreviewLinks],
  );

  const clearPreview = useCallback(() => setPreviewLinks([]), [setPreviewLinks]);

  return (
    <Panel
      title="Agents"
      badge={working > 0 ? `${working} ativo${working > 1 ? 's' : ''}` : `${agents.length} disponíveis`}
      action={<PinToggle />}
      style={{ flex: '0 0 auto', maxHeight: '38vh' }}
    >
      {agents.length >= SEARCHABLE_FROM && (
        <PanelSearch value={query} onChange={setQuery} placeholder="filtrar agente…" />
      )}
      <PanelBody ref={listRef}>
        {agents.length === 0 ? (
          <PanelEmpty>nenhum agente registrado — o servidor ainda não enviou o catálogo</PanelEmpty>
        ) : ordered.length === 0 ? (
          <PanelEmpty>nenhum agente com “{query}”</PanelEmpty>
        ) : (
          ordered.map((agent) => (
            <div key={agent.id} data-flip-key={agent.id}>
              <EntityCard
                kind="agent"
                id={agent.id}
                name={agent.name}
                role={agent.role}
                hint={agent.source ? `${agent.name} — instalado por ${agent.source}` : agent.name}
                color={agent.color}
                initials={agent.initials}
                active={agent.state === 'working'}
                progress={agent.progress ?? 0}
                onHoverStart={() => preview(agent.id)}
                onHoverEnd={clearPreview}
              />
            </div>
          ))
        )}
      </PanelBody>
    </Panel>
  );
}

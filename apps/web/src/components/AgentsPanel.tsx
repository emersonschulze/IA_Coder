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
  const skills = useSession((state) => state.skills);
  const setPreviewLinks = useSession((state) => state.setPreviewLinks);
  const hasServerLinks = useSession((state) => state.links.length > 0);

  const pinActive = usePrefs((state) => state.pinActive);
  const listRef = useFlipList<HTMLDivElement>();
  const [query, setQuery] = useState('');

  const working = agents.filter((agent) => agent.state === 'working').length;
  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);

  /*
   * A segunda linha do cartão troca de assunto conforme o agente trabalha.
   *
   * Parado, ela diz de onde ele veio (o plugin/fonte, ex. "PROJETO") — que é o
   * que importa quando você está escolhendo. Trabalhando, ela diz a SKILL em curso, porque
   * aí a pergunta virou outra: não é mais "quem é este agente", é "o que ele
   * está fazendo agora". Um dev-qa tem sete skills e passa por várias numa
   * tarefa só; a origem dele não muda nunca e não responde nada.
   */
  const lineFor = (role: string, state: string, skillId?: string | null): string => {
    if (state !== 'working' || !skillId) return role;
    const skill = skillById.get(skillId);
    if (!skill) return role;
    return skill.kind === 'skill' ? `▸ ${skill.name}` : `▸ ${skill.name.toLowerCase()}`;
  };
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
          ordered.map((agent, index) => (
            <div key={agent.id} data-flip-key={agent.id}>
              <EntityCard
                kind="agent"
                id={agent.id}
                name={agent.name}
                role={lineFor(agent.role, agent.state, agent.skillId)}
                hint={[
                  agent.source ? `${agent.name} — instalado por ${agent.source}` : agent.name,
                  agent.state === 'working' && agent.skillId
                    ? `usando: ${skillById.get(agent.skillId)?.name ?? agent.skillId}`
                    : '',
                ].filter(Boolean).join('\n')}
                color={agent.color}
                initials={agent.initials}
                active={agent.state === 'working'}
                scrollOnActive={!pinActive || index === 0}
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

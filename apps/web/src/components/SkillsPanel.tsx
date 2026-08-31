import { useMemo, useState } from 'react';
import { useFlipList } from '@/hooks/useFlipList';
import { useSession } from '@/store/useSession';
import { pinnedFirst, usePrefs } from '@/store/usePrefs';
import { matches } from '@/lib/format';
import { EntityCard } from './EntityCard';
import { Panel, PanelBody, PanelEmpty, PanelSearch } from './Panel';
import { PinToggle } from './PinToggle';

/** A partir daqui a lista não se varre com o olho — entra o campo de busca. */
const SEARCHABLE_FROM = 12;

/**
 * Skill — o que este Claude Code sabe fazer nesta máquina.
 *
 * São duas naturezas na mesma lista: os grupos de ferramenta (leitura, edição,
 * shell…), que acendem a cada passo da execução, e as skills instaladas de
 * verdade — plugin, `.claude` do projeto ou o seu. O servidor varre o disco
 * para achar as segundas; aqui é só vitrine.
 */
export function SkillsPanel() {
  const skills = useSession((state) => state.skills);
  const pinActive = usePrefs((state) => state.pinActive);
  const listRef = useFlipList<HTMLDivElement>();
  const [query, setQuery] = useState('');

  const inUse = skills.filter((skill) => skill.inUse).length;
  const installed = skills.filter((skill) => skill.kind === 'skill').length;

  const ordered = useMemo(() => {
    const found = skills.filter((skill) => matches(query, skill.name, skill.detail, skill.source));
    return pinnedFirst(found, (skill) => skill.inUse, pinActive);
  }, [skills, pinActive, query]);

  const badge = inUse > 0
    ? `${inUse} em uso`
    : installed > 0
      ? `${skills.length} · ${installed} instaladas`
      : `${skills.length} disponíveis`;

  return (
    <Panel
      title="Skill"
      badge={badge}
      action={<PinToggle />}
      style={{ flex: '1 1 auto' }}
    >
      {skills.length >= SEARCHABLE_FROM && (
        <PanelSearch value={query} onChange={setQuery} placeholder="filtrar skill…" />
      )}
      <PanelBody ref={listRef}>
        {skills.length === 0 ? (
          <PanelEmpty>nenhuma skill registrada — o servidor ainda não enviou o catálogo</PanelEmpty>
        ) : ordered.length === 0 ? (
          <PanelEmpty>nenhuma skill com “{query}”</PanelEmpty>
        ) : (
          ordered.map((skill) => (
            <div key={skill.id} data-flip-key={skill.id}>
              <EntityCard
                kind="skill"
                id={skill.id}
                name={skill.name}
                role={skill.detail}
                hint={skill.source ? `${skill.source} · ${skill.detail}` : skill.detail}
                color={skill.color}
                initials={skill.initials}
                active={skill.inUse}
              />
            </div>
          ))
        )}
      </PanelBody>
    </Panel>
  );
}

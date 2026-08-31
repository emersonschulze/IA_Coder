import { useMemo } from 'react';
import { useFlipList } from '@/hooks/useFlipList';
import { useSession } from '@/store/useSession';
import { pinnedFirst, usePrefs } from '@/store/usePrefs';
import { EntityCard } from './EntityCard';
import { Panel, PanelBody, PanelEmpty } from './Panel';
import { PinToggle } from './PinToggle';

export function SkillsPanel() {
  const skills = useSession((state) => state.skills);
  const pinActive = usePrefs((state) => state.pinActive);
  const listRef = useFlipList<HTMLDivElement>();

  const inUse = skills.filter((skill) => skill.inUse).length;
  const ordered = useMemo(
    () => pinnedFirst(skills, (skill) => skill.inUse, pinActive),
    [skills, pinActive],
  );

  return (
    <Panel
      title="Skill"
      badge={inUse > 0 ? `${inUse} em uso` : `${skills.length} disponíveis`}
      action={<PinToggle />}
      style={{ flex: '1 1 auto' }}
    >
      <PanelBody ref={listRef}>
        {skills.length === 0 ? (
          <PanelEmpty>nenhuma skill registrada — o servidor ainda não enviou o catálogo</PanelEmpty>
        ) : (
          ordered.map((skill) => (
            <div key={skill.id} data-flip-key={skill.id}>
              <EntityCard
                kind="skill"
                id={skill.id}
                name={skill.name}
                role={skill.detail}
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

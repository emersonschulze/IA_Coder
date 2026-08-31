import { useSession } from '@/store/useSession';
import { duration } from '@/lib/format';
import { AgentBlock } from './AgentBlock';
import styles from './Working.module.css';
import panels from './Panels.module.css';

const STATE_TAG: Record<string, string> = {
  idle: '◇ OCIOSO',
  running: '◈ EXECUTANDO',
  done: '✓ CONCLUÍDO',
  failed: '✕ FALHOU',
  cancelled: '■ ABORTADO',
};

export function Working() {
  const workflow = useSession((state) => state.workflow);
  const blocks = useSession((state) => state.blocks);
  const agents = useSession((state) => state.agents);
  const skills = useSession((state) => state.skills);
  const connection = useSession((state) => state.connection);

  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const skillById = new Map(skills.map((skill) => [skill.id, skill]));

  return (
    <section className={[panels.panel, styles.working].join(' ')}>
      <header className={styles.header}>
        <div className={styles.kicker}>
          {workflow ? `Workflow ativo · ${workflow.id}` : 'Nenhum workflow em execução'}
        </div>
        <h1 className={[styles.title, workflow ? '' : styles.titleIdle].filter(Boolean).join(' ')}>
          {workflow?.title ?? 'Descreva na caixa ao lado o que você quer construir.'}
        </h1>
        <div className={styles.tags}>
          <span
            className={[
              styles.tag,
              workflow?.state === 'running' ? styles.tagHot : '',
              workflow?.state === 'done' ? styles.tagDone : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {STATE_TAG[workflow?.state ?? 'idle']}
          </span>
          <span className={styles.tag}>{blocks.length} agentes</span>
          {workflow && (
            <span className={styles.tag}>
              etapa {workflow.step + 1}/{workflow.totalSteps}
            </span>
          )}
          {workflow?.etaSeconds !== undefined && (
            <span className={styles.tag}>ETA {duration(workflow.etaSeconds)}</span>
          )}
        </div>
        <i className={styles.progress} style={{ width: `${workflow?.progress ?? 0}%` }} />
      </header>

      <div className={styles.blocks}>
        {blocks.length === 0 ? (
          <div className={styles.idle}>
            <strong>WORKFLOW VAZIO</strong>
            {connection === 'open'
              ? 'Mande um comando por texto ou por voz. Cada agente convocado vira um bloco aqui.'
              : 'Sem link com o servidor local do IA_Coder. Assim que ele subir, os blocos aparecem sozinhos.'}
          </div>
        ) : (
          blocks.map((block, index) => (
            <AgentBlock
              key={block.id}
              block={block}
              agent={agentById.get(block.agentId)}
              skill={block.skillId ? skillById.get(block.skillId) : undefined}
              position={index + 1}
            />
          ))
        )}
      </div>
    </section>
  );
}

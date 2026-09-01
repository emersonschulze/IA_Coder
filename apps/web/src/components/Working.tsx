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

interface Props {
  /** Abre o arquivo gerado com o programa padrão do Windows (comando `artifact.open`). */
  onOpenArtifact: (path: string, reveal?: boolean) => void;
}

export function Working({ onOpenArtifact }: Props) {
  const workflow = useSession((state) => state.workflow);
  const blocks = useSession((state) => state.blocks);
  const agents = useSession((state) => state.agents);
  const skills = useSession((state) => state.skills);
  const connection = useSession((state) => state.connection);

  const investigando = workflow?.kind === 'investigation';
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const skillById = new Map(skills.map((skill) => [skill.id, skill]));

  return (
    <section className={[panels.panel, styles.working].join(' ')}>
      {/*
        Duas naturezas no mesmo painel. Execução é o que nasce do "pode ir";
        investigação é o agente lendo o projeto para responder no Talking. As
        duas aparecem aqui, porque ler também é trabalho — mas dizer qual é
        importa: numa ele está mexendo nos seus arquivos, na outra não.
      */}
      <header className={styles.header}>
        <div className={styles.kicker}>
          {workflow
            ? `${investigando ? 'Investigando' : 'Workflow ativo'} · ${workflow.id}`
            : 'Nenhum workflow em execução'}
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
            {investigando && workflow?.state === 'running'
              ? '◈ INVESTIGANDO'
              : STATE_TAG[workflow?.state ?? 'idle']}
          </span>
          <span className={styles.tag}>
            {blocks.length} {blocks.length === 1 ? 'agente' : 'agentes'}
          </span>
          {/* Nunca soube quantos passos faltam: passo e total são o mesmo
              contador de ferramentas. Somar 1 dava "etapa 3/2". É contagem,
              não progresso — então é assim que se mostra. */}
          {workflow && workflow.step > 0 && (
            <span className={styles.tag}>
              {workflow.step} {workflow.step === 1 ? 'passo' : 'passos'}
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
              onOpenArtifact={onOpenArtifact}
            />
          ))
        )}
      </div>
    </section>
  );
}

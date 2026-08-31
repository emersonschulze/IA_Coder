import { useEffect, useState } from 'react';
import { useSession } from '@/store/useSession';
import { Panel, PanelEmpty } from './Panel';
import styles from './ResultPanel.module.css';

interface Props {
  onSaveKnowledge: () => void;
  /** Abre o arquivo gerado com o programa padrão do Windows. */
  onOpenArtifact: (path: string, reveal?: boolean) => void;
}

/**
 * Result — o consolidado de uma execução.
 *
 * Só isto: o resumo final e os arquivos gerados. O que cada agente fez passo a
 * passo já aparece ao vivo no Working, no meio da tela; aqui é só o "pronto,
 * ficou assim" no fim. Pedir e conversar saiu daqui — foi tudo para o painel
 * de Conversa, junto (voz e texto no mesmo lugar).
 */
export function ResultPanel({ onSaveKnowledge, onOpenArtifact }: Props) {
  const result = useSession((state) => state.result);
  const workflowState = useSession((state) => state.workflow?.state);
  const treeReady = useSession((state) => state.treeStatus === 'ok');
  const [saved, setSaved] = useState(false);

  // O botão de guardar só faz sentido depois que a análise terminou bem.
  const canSave = workflowState === 'done' && treeReady;
  useEffect(() => setSaved(false), [workflowState]);

  const badge = workflowState === 'running' ? 'em execução…' : result ? 'pronto' : undefined;

  return (
    <Panel title="Result" badge={badge} zoomable style={{ flex: '0 0 auto' }}>
      <div className={styles.wrap}>
        {!result ? (
          <PanelEmpty>
            {workflowState === 'running'
              ? 'a execução está rolando — o consolidado aparece aqui quando terminar'
              : 'nada gerado ainda nesta sessão'}
          </PanelEmpty>
        ) : (
          <div className={styles.answer}>
            <span className={styles.answerLabel}>Resultado</span>
            {result.text || 'Execução concluída.'}

            {result.artifacts.length > 0 && (
              <div className={styles.artifacts}>
                {result.artifacts.map((artifact) => (
                  <button
                    key={artifact.id}
                    type="button"
                    className={styles.artifact}
                    onClick={() => artifact.href && onOpenArtifact(artifact.href)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (artifact.href) onOpenArtifact(artifact.href, true);
                    }}
                    title={`${artifact.href ?? artifact.name}\n(clique abre · botão direito mostra na pasta)`}
                  >
                    ↗ {artifact.name}
                  </button>
                ))}
              </div>
            )}

            {canSave && (
              <button
                type="button"
                className={styles.save}
                disabled={saved}
                onClick={() => {
                  onSaveKnowledge();
                  setSaved(true);
                }}
                title="Grava esta análise como assunto reutilizável — da próxima vez ela entra como contexto pronto"
              >
                {saved ? '✓ guardado' : '✓ Guardar no Tree'}
              </button>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

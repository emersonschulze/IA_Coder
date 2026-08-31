import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '@/store/useSession';
import { Panel } from './Panel';
import styles from './PromptBox.module.css';

interface Props {
  onSubmit: (text: string, source: 'text' | 'voice') => void;
  onSaveKnowledge: () => void;
  /** Abre o arquivo gerado com o programa padrão do Windows. */
  onOpenArtifact: (path: string, reveal?: boolean) => void;
  ttsEnabled: boolean;
  onToggleTts: () => void;
  speaking: boolean;
}

/**
 * A caixa de comando escrita.
 *
 * A voz saiu daqui de propósito: virou o painel de Conversa, que é hands-free e
 * usa o Whisper local. Ter dois microfones na mesma tela disputava o mesmo
 * dispositivo e confundia — aqui é só teclado, e o pedido vai direto para a
 * execução, sem passar pela conversa.
 */
export function PromptBox({
  onSubmit,
  onSaveKnowledge,
  onOpenArtifact,
  ttsEnabled,
  onToggleTts,
  speaking,
}: Props) {
  const [text, setText] = useState('');
  const connection = useSession((state) => state.connection);
  // Conversa fica no painel de Conversa. Aqui mora o que SAIU de uma execução:
  // o resumo e os arquivos gerados, com um clique para abrir.
  const result = useSession((state) => state.result);
  const workflowState = useSession((state) => state.workflow?.state);
  const treeReady = useSession((state) => state.treeStatus === 'ok');
  const [saved, setSaved] = useState(false);

  // O botão de guardar só faz sentido depois que a análise terminou bem.
  const canSave = workflowState === 'done' && treeReady;
  useEffect(() => setSaved(false), [workflowState]);
  const lastSource = useRef<'text' | 'voice'>('text');
  const committed = useRef('');

  const submit = useCallback(() => {
    const value = text.trim();
    if (!value) return;
    onSubmit(value, lastSource.current);
    setText('');
    committed.current = '';
    lastSource.current = 'text';
  }, [onSubmit, text]);

  // Ctrl+Enter envia de qualquer lugar da tela.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [submit]);

  const badge = speaking ? 'falando…' : 'Ctrl+Enter envia';

  return (
    <Panel title="Caixa de Texto" badge={badge} zoomable style={{ flex: '0 0 auto' }}>
      <div className={styles.wrap}>
        <textarea
          className={styles.input}
          value={text}
          onChange={(event) => {
            lastSource.current = 'text';
            setText(event.target.value);
            committed.current = event.target.value;
          }}
          placeholder={'Descreva o que você quer construir…\nEx.: crie o CRUD de clientes em C# e a tela em React'}
        />

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.run}
            onClick={submit}
            disabled={!text.trim() || connection !== 'open'}
            title={connection === 'open' ? 'Ctrl+Enter' : 'sem link com o servidor'}
          >
            ▶ Executar workflow
          </button>
          <button
            type="button"
            className={[styles.mini, ttsEnabled ? styles.miniOn : ''].filter(Boolean).join(' ')}
            onClick={onToggleTts}
            title="Resposta falada"
          >
            {ttsEnabled ? '🔊' : '🔇'}
          </button>
          <button
            type="button"
            className={styles.mini}
            onClick={() => {
              setText('');
              committed.current = '';
            }}
            title="Limpar"
          >
            ✕
          </button>
        </div>

        {result && (
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

        {connection !== 'open' && (
          <p className={styles.notice}>
            sem link com o servidor local — o comando só é enviado quando a conexão voltar
          </p>
        )}
      </div>
    </Panel>
  );
}

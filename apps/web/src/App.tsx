import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnchorProvider } from '@/anchors/AnchorContext';
import { AgentsPanel } from '@/components/AgentsPanel';
import { AuthGate } from '@/components/AuthGate';
import { ConversationPanel } from '@/components/ConversationPanel';
import { McpGate } from '@/components/McpGate';
import { ProjectPicker } from '@/components/ProjectPicker';
import { SubjectDialog } from '@/components/SubjectDialog';
import { SkillsPanel } from '@/components/SkillsPanel';
import { StatusArchivesPanel } from '@/components/StatusArchivesPanel';
import { Topbar } from '@/components/Topbar';
import { TreePanel } from '@/components/TreePanel';
import { WireLayer } from '@/components/WireLayer';
import { Working } from '@/components/Working';
import { useSpeechOutput } from '@/hooks/useSpeechOutput';
import { IaCoderSocket } from '@/lib/ws';
import { selectIsFocusing, useSession } from '@/store/useSession';
import type { ImageAttachment } from '@/types/domain';
import styles from './App.module.css';

export default function App() {
  const apply = useSession((state) => state.apply);
  const setConnection = useSession((state) => state.setConnection);
  const workflowId = useSession((state) => state.workflow?.id);
  const conversationActive = useSession((state) => state.conversation.active);
  const focusing = useSession(selectIsFocusing);
  const mcpBlocked = useSession((state) => state.mcp?.blocked ?? null);

  const speech = useSpeechOutput();
  const socket = useRef<IaCoderSocket | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  /** `null` = fechado. String = aberto, com o nome já sugerido. */
  const [subjectForm, setSubjectForm] = useState<string | null>(null);

  useEffect(() => {
    const client = new IaCoderSocket({
      // Um único narrador na aplicação: o painel de Conversa, que é quem
      // controla o microfone. Falar daqui também deixava as duas vozes se
      // atropelando — e, pior, com o microfone aberto, ele se ouvia.
      onEvent: apply,
      onState: (state, detail) => setConnection(state, detail),
    });
    socket.current = client;
    client.connect();
    return () => {
      client.dispose();
      socket.current = null;
    };
  }, [apply, setConnection]);

  const cancel = useCallback(() => {
    if (workflowId) socket.current?.send({ type: 'workflow.cancel', id: workflowId });
  }, [workflowId]);

  const inspect = useCallback((agentId: string) => {
    socket.current?.send({ type: 'agent.inspect', agentId });
  }, []);

  const browse = useCallback((path?: string) => {
    socket.current?.send({ type: 'project.browse', path });
  }, []);

  const pickNative = useCallback(() => {
    socket.current?.send({ type: 'project.pick' });
  }, []);

  const listSubjects = useCallback(() => {
    socket.current?.send({ type: 'tree.list' });
  }, []);

  const openSubject = useCallback((subjectId: string) => {
    socket.current?.send({ type: 'tree.open', subjectId });
  }, []);

  const saveKnowledge = useCallback(() => {
    socket.current?.send({ type: 'knowledge.save' });
  }, []);

  const discardKnowledge = useCallback(() => {
    socket.current?.send({ type: 'knowledge.discard' });
  }, []);

  const saveSubjectManually = useCallback((title: string, summary: string, tags: string[]) => {
    socket.current?.send({ type: 'knowledge.manual', title, summary, tags });
    setSubjectForm(null);
  }, []);

  const openArtifact = useCallback((path: string, reveal?: boolean) => {
    socket.current?.send({ type: 'artifact.open', path, reveal });
  }, []);

  const openLogin = useCallback(() => {
    socket.current?.send({ type: 'auth.login', mode: 'shell' });
  }, []);

  const openLoginWindow = useCallback(() => {
    socket.current?.send({ type: 'auth.login', mode: 'window' });
  }, []);

  const recheckAuth = useCallback(() => {
    socket.current?.send({ type: 'auth.check' });
  }, []);

  const openMcpLogin = useCallback((server: string) => {
    socket.current?.send({ type: 'mcp.login', server, mode: 'shell' });
  }, []);

  const openMcpLoginWindow = useCallback((server: string) => {
    if (server) socket.current?.send({ type: 'mcp.login', server, mode: 'window' });
  }, []);

  const recheckMcp = useCallback(() => {
    socket.current?.send({ type: 'mcp.check' });
  }, []);

  /*
   * Fechar o aviso avisa o SERVIDOR, não só a tela.
   *
   * `blocked` fica guardado lá; sem esse recado, qualquer aba que recarregasse
   * receberia o mesmo bloqueio de novo e o popup voltaria sozinho para um
   * problema que você já viu.
   */
  const closeMcp = useCallback(() => {
    setMcpOpen(false);
    if (mcpBlocked) socket.current?.send({ type: 'mcp.dismiss' });
  }, [mcpBlocked]);

  /*
   * Uma ferramenta de MCP barrada abre o popup sozinha — é o único momento em
   * que ele aparece sem você pedir, e é o momento em que ele resolve alguma
   * coisa: você acabou de perguntar algo que dependia daquele servidor.
   */
  useEffect(() => {
    if (mcpBlocked) setMcpOpen(true);
  }, [mcpBlocked]);

  const startConversation = useCallback(() => {
    socket.current?.send({ type: 'conversation.start' });
  }, []);

  const stopConversation = useCallback(() => {
    socket.current?.send({ type: 'conversation.stop' });
  }, []);

  const conversationInput = useCallback((text: string, images?: ImageAttachment[]) => {
    socket.current?.send({ type: 'conversation.input', text, images });
  }, []);

  const confirmPlan = useCallback((accept: boolean) => {
    socket.current?.send({ type: 'conversation.confirm', accept });
  }, []);

  const chooseProject = useCallback((path: string) => {
    socket.current?.send({ type: 'project.set', path });
    setPickerOpen(false);
  }, []);

  const restartRuntimes = useCallback(() => {
    socket.current?.send({ type: 'runtime.restart', target: 'both' });
  }, []);

  const stageClass = useMemo(
    () => [styles.stage, focusing ? styles.focusing : ''].filter(Boolean).join(' '),
    [focusing],
  );

  return (
    <AnchorProvider>
      <div className="app-backdrop" />
      <div className="app-scanlines" />

      <div className={styles.shell}>
        <Topbar
          onCancel={cancel}
          onOpenProject={() => setPickerOpen(true)}
          onRestart={restartRuntimes}
          ttsEnabled={speech.enabled}
          onToggleTts={() => speech.setEnabled(!speech.enabled)}
          conversationActive={conversationActive}
          onToggleConversation={() => (conversationActive ? stopConversation() : startConversation())}
          onOpenMcp={() => setMcpOpen(true)}
        />

        <div className={stageClass}>
          <div className={styles.column}>
            <AgentsPanel onInspect={inspect} />
            <SkillsPanel />
            <StatusArchivesPanel onOpenArtifact={openArtifact} />
          </div>

          <Working onOpenArtifact={openArtifact} />

          <div className={styles.column}>
            <ConversationPanel
              onInput={conversationInput}
              onConfirm={confirmPlan}
              onSaveKnowledge={saveKnowledge}
              onDiscardKnowledge={discardKnowledge}
              onOpenSubjectForm={(title) => setSubjectForm(title)}
              onOpenArtifact={openArtifact}
              ttsEnabled={speech.enabled}
            />
            <TreePanel
              onList={listSubjects}
              onOpen={openSubject}
              onNewSubject={() => setSubjectForm('')}
            />
          </div>
        </div>
      </div>

      <WireLayer />

      <AuthGate onLogin={openLogin} onLoginWindow={openLoginWindow} onRecheck={recheckAuth} />

      {mcpOpen && (
        <McpGate
          onLogin={openMcpLogin}
          onLoginWindow={openMcpLoginWindow}
          onRecheck={recheckMcp}
          onClose={closeMcp}
        />
      )}

      {subjectForm !== null && (
        <SubjectDialog
          initialTitle={subjectForm}
          onSave={saveSubjectManually}
          onClose={() => setSubjectForm(null)}
        />
      )}

      {pickerOpen && (
        <ProjectPicker
          onBrowse={browse}
          onPickNative={pickNative}
          onConfirm={chooseProject}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </AnchorProvider>
  );
}

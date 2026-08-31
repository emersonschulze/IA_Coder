import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnchorProvider } from '@/anchors/AnchorContext';
import { AgentsPanel } from '@/components/AgentsPanel';
import { AuthGate } from '@/components/AuthGate';
import { ConversationPanel } from '@/components/ConversationPanel';
import { ProjectPicker } from '@/components/ProjectPicker';
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

  const speech = useSpeechOutput();
  const socket = useRef<IaCoderSocket | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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
        />

        <div className={stageClass}>
          <div className={styles.column}>
            <AgentsPanel onInspect={inspect} />
            <SkillsPanel />
            <StatusArchivesPanel />
          </div>

          <Working />

          <div className={styles.column}>
            <ConversationPanel
              onInput={conversationInput}
              onConfirm={confirmPlan}
              onSaveKnowledge={saveKnowledge}
              onOpenArtifact={openArtifact}
              ttsEnabled={speech.enabled}
            />
            <TreePanel onList={listSubjects} onOpen={openSubject} />
          </div>
        </div>
      </div>

      <WireLayer />

      <AuthGate onLogin={openLogin} onLoginWindow={openLoginWindow} onRecheck={recheckAuth} />

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

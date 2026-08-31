/**
 * Servidor de ensaio do IA_Coder (apenas para desenvolvimento do frontend).
 *
 *   npm run mock      → sobe em ws://localhost:8787/ws
 *
 * Ele fala o mesmo protocolo descrito em docs/PROTOCOLO.md, mas com um roteiro fixo:
 * serve para ver a interface viva enquanto o servidor de verdade (spawn do PowerShell)
 * ainda não existe. Não é usado em produção — o frontend não sabe que ele existe.
 *
 * Fluxo simulado: você fala com o Talking (`conversation.input`), o mock devolve um
 * plano (`conversation.turn` + `conversation.state.pending`); você confirma
 * (`conversation.confirm`) e só aí ele "executa" o roteiro abaixo, com blocos, setas
 * e arquivos de verdade — igual ao servidor real depois do seu "pode ir".
 */
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);

const AGENTS = [
  { id: 'be1', name: 'Backend1', role: 'API · DOMÍNIO · EF', initials: 'BE', color: '#22d3ee', state: 'idle' },
  { id: 'fe', name: 'Frontend', role: 'UI · UX · REACT', initials: 'FE', color: '#a855f7', state: 'idle' },
  { id: 'qa', name: 'QA-Sentinel', role: 'TESTES · REGRESSÃO', initials: 'QA', color: '#34d399', state: 'idle' },
  { id: 'ops', name: 'DevOps', role: 'BUILD · PIPELINE', initials: 'OP', color: '#fbbf24', state: 'idle' },
];

const SKILLS = [
  { id: 'csharp', name: 'C#', detail: '.NET 8 · MINIMAL API', initials: 'C#', color: '#22d3ee', inUse: false },
  { id: 'react', name: 'React', detail: 'VITE · TS · TAILWIND', initials: 'RE', color: '#a855f7', inUse: false },
  { id: 'sql', name: 'SQL Server', detail: 'MIGRATIONS · INDEX', initials: 'SQ', color: '#38bdf8', inUse: false },
  { id: 'test', name: 'xUnit', detail: 'UNIT · INTEGRAÇÃO', initials: 'XU', color: '#34d399', inUse: false },
  { id: 'docker', name: 'Docker', detail: 'COMPOSE · CI', initials: 'DK', color: '#fbbf24', inUse: false },
];

const SCRIPT = [
  { agent: 'be1', skill: 'csharp', action: 'Modelando entidades do domínio',
    logs: ['scaffold Domain/Entities/User.cs', 'validando invariantes do agregado', '✓ entidade criada'],
    files: [['User.cs', 'code'], ['RefreshToken.cs', 'code']] },
  { agent: 'be1', skill: 'sql', action: 'Gerando migration e índices únicos',
    logs: ['dotnet ef migrations add AddIdentity', 'índice UX_User_Email aplicado', '✓ migration ok'],
    files: [['20260830_AddIdentity.sql', 'code']] },
  { agent: 'fe', skill: 'react', action: 'Construindo tela e store de sessão',
    logs: ['criando <LoginForm/> com react-hook-form', 'ligando authStore ao endpoint', '✓ rota /login publicada'],
    files: [['LoginForm.tsx', 'code'], ['authStore.ts', 'code']] },
  { agent: 'qa', skill: 'test', action: 'Escrevendo testes de autenticação',
    logs: ['12 casos de borda mapeados', 'executando suíte xUnit…', '✓ 12/12 verdes'],
    files: [['AuthTests.cs', 'code']] },
  { agent: 'ops', skill: 'docker', action: 'Publicando pipeline e imagem',
    logs: ['docker build -t iacoder/api:0.4', 'push para o registry interno', '✓ pipeline verde'],
    files: [['Dockerfile', 'code'], ['ci.yml', 'json']] },
];

// O Tree agora vem do Postgres, pelo servidor de verdade — o mock não simula.

const wss = new WebSocketServer({ port: PORT, path: '/ws' });
console.log(`[mock] IA_Coder em ws://localhost:${PORT}/ws`);

wss.on('connection', (socket) => {
  const send = (event) => socket.readyState === 1 && socket.send(JSON.stringify(event));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let tokens = 18_400;
  let cancelled = false;
  let pending = null;

  const usage = () => send({ type: 'usage', usage: {
    tokensUsed: tokens, tokensLimit: 200_000,
    contextPct: Math.min(97, 28 + tokens / 4000), costUsd: tokens * 0.000023, plan: 'PRO',
    windowPct: Math.min(95, 12 + tokens / 5000), windowResetsAt: Date.now() + 3 * 60 * 60_000,
    weekPct: 34, weekResetsAt: Date.now() + 4 * 24 * 60 * 60_000,
  }});

  const publishConversation = () => send({ type: 'conversation.state', state: { active: false, thinking: false, pending } });
  const agentSays = (text) => {
    send({ type: 'conversation.turn', role: 'agent', text });
    send({ type: 'conversation.say', text });
  };

  send({ type: 'session.hello', session: { id: 'mock', startedAt: Date.now(), runtime: 'MOCK', plan: 'PRO' } });
  send({ type: 'agents.sync', agents: AGENTS });
  send({ type: 'skills.sync', skills: SKILLS });
  send({ type: 'tree.subjects', graph: { nodes: [], edges: [] }, status: 'unreachable' });
  send({ type: 'archives.sync', archives: [] });
  publishConversation();
  usage();

  const runWorkflow = async (title) => {
    cancelled = false;
    const wfId = `wf_${Date.now().toString(36)}`;
    send({ type: 'workflow.started', workflow: {
      id: wfId, title, state: 'running', step: 0,
      totalSteps: SCRIPT.length, progress: 0, startedAt: Date.now(),
    }});

    const order = [...new Set(SCRIPT.map((s) => s.agent))];
    order.forEach((agentId, index) => send({ type: 'block.upsert', block: {
      id: `blk_${agentId}`, agentId, index, action: '', skillId: null,
      state: 'queued', progress: 0, logs: [], artifacts: [],
    }}));

    for (const [index, step] of SCRIPT.entries()) {
      if (cancelled) break;
      const blockId = `blk_${step.agent}`;

      send({ type: 'agent.state', agentId: step.agent, state: 'working', skillId: step.skill, progress: 0 });
      send({ type: 'skill.state', skillId: step.skill, inUse: true });
      send({ type: 'block.patch', patch: { id: blockId, state: 'running', action: step.action, skillId: step.skill, progress: 0, logs: [], artifacts: [] } });
      send({ type: 'link.activated', link: { id: `lk_${index}_b`, from: { kind: 'agent', id: step.agent }, to: { kind: 'block', id: blockId }, label: 'executa' } });
      send({ type: 'link.activated', link: { id: `lk_${index}_s`, from: { kind: 'agent', id: step.agent }, to: { kind: 'skill', id: step.skill }, label: 'usa' } });

      if (index === 0) agentSays(`Fechado, começando agora: ${step.action.toLowerCase()}.`);

      for (const [k, text] of step.logs.entries()) {
        await sleep(700);
        if (cancelled) break;
        send({ type: 'block.log', blockId, entry: { ts: Date.now(), level: text.startsWith('✓') ? 'ok' : 'info', text } });
        const progress = Math.round(((k + 1) / step.logs.length) * 100);
        send({ type: 'block.patch', patch: { id: blockId, progress } });
        send({ type: 'agent.state', agentId: step.agent, state: 'working', progress });
        tokens += 900 + Math.random() * 1200;
        usage();
      }

      for (const [name, kind] of step.files) {
        const artifact = { id: `${blockId}_${name}`, name, kind, createdAt: Date.now() };
        send({ type: 'block.artifact', blockId, artifact });
        send({ type: 'archive.added', archive: artifact });
      }

      send({ type: 'link.deactivated', linkId: `lk_${index}_b` });
      send({ type: 'link.deactivated', linkId: `lk_${index}_s` });
      send({ type: 'skill.state', skillId: step.skill, inUse: false });
      send({ type: 'agent.state', agentId: step.agent, state: 'done', progress: 100 });
      send({ type: 'block.patch', patch: { id: blockId, state: 'done', progress: 100 } });
      send({ type: 'workflow.updated', patch: {
        id: wfId, step: index, progress: Math.round(((index + 1) / SCRIPT.length) * 100),
        etaSeconds: (SCRIPT.length - index - 1) * 22,
      }});
      await sleep(400);
    }

    AGENTS.forEach((a) => send({ type: 'agent.state', agentId: a.id, state: 'idle', skillId: null, progress: 0 }));
    const summary = cancelled
      ? 'Workflow abortado.'
      : 'Pronto: API de autenticação, tela de login e pipeline publicados, com os 12 testes verdes.';
    send({ type: 'workflow.finished', id: wfId, state: cancelled ? 'cancelled' : 'done', summary });
    agentSays(summary);
  };

  socket.on('message', async (raw) => {
    let command;
    try { command = JSON.parse(String(raw)); } catch { return; }

    if (command.type === 'ping') return send({ type: 'pong' });
    if (command.type === 'workflow.cancel') { cancelled = true; return; }
    if (command.type === 'knowledge.save') return send({ type: 'knowledge.saved', id: 'mock', title: 'Autenticação de usuários' });
    if (command.type === 'tree.list') return send({ type: 'tree.subjects', graph: { nodes: [], edges: [] }, status: 'unreachable' });

    if (command.type === 'conversation.confirm') {
      if (!command.accept) {
        pending = null;
        publishConversation();
        agentSays('Beleza, cancelei. O que você prefere?');
        return;
      }
      const title = pending?.title ?? 'Execução combinada';
      pending = null;
      publishConversation();
      await runWorkflow(title);
      return;
    }

    if (command.type !== 'conversation.input') return;

    send({ type: 'conversation.turn', role: 'user', text: command.text, images: command.images });
    send({ type: 'conversation.state', state: { active: false, thinking: true, pending } });
    await sleep(1100);

    pending = {
      title: command.text,
      steps: [
        'Modelar entidades e migration no backend (.NET + EF)',
        'Construir a tela de login em React, ligada ao endpoint',
        'Cobrir com testes automatizados (xUnit)',
        'Publicar pipeline e imagem Docker',
      ],
      risk: 'low',
    };
    agentSays(`Beleza, entendi: ${command.text.toLowerCase()}. Posso ir?`);
    publishConversation();
  });
});

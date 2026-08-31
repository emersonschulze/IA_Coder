import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  checkAuth, extractUrls, loginViaShell, looksLikeAuthFailure, openLoginTerminal, type AuthState,
} from './auth.js';
import { ClaudeSession } from './claude.js';
import { config } from './config.js';
import { closeDb, dbReady, dbState, initDb } from './db.js';
import {
  extractionPrompt, forgetSubject, parseExtraction, recall, recallBlock,
  saveSubject, subjectDetail, subjectGraph,
} from './knowledge.js';
import { openArtifact, pickFolderNative } from './picker.js';
import { isUsableDirectory, listDirectory, listRoots, projectName } from './fsbrowser.js';
import { Orchestrator } from './orchestrator.js';
import { readPrefs, writePrefs } from './prefs.js';
import type { ClientCommand, ImageAttachment, ProjectState, ServerEvent } from './protocol.js';
import { ShellSession } from './shell.js';
import { Conversation, soundsLikeNo, soundsLikeYes } from './conversation.js';
import { checkVoice, matchesWake, synthesize, transcribe, voiceHealth, wakeWord } from './voice.js';
import { fetchAccountUsage } from './usage.js';

const startedAt = Date.now();
const VERSION = '0.3.0';
/** Comandos que esta versão entende — anunciados no handshake. */
const FEATURES = ['project', 'picker', 'tree', 'knowledge'];
const clients = new Set<WebSocket>();

const broadcast = (event: ServerEvent): void => {
  const frame = JSON.stringify(event);
  clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(frame);
  });
};

const send = (client: WebSocket, event: ServerEvent): void => {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
};

/* -------------------------------------------------------------- processos -- */

let prefs = readPrefs();
const shell = new ShellSession(prefs.projectPath);
const claude = new ClaudeSession(prefs.projectPath);
/**
 * Narração da execução.
 *
 * O pedido era "me retorne de forma interativa o que aconteceu" — e o oposto
 * disso é tanto o silêncio quanto a tagarelice. Então: avisa ao começar, dá
 * sinal de vida de vez em quando dizendo o que está fazendo agora, fala se der
 * erro, e no fim lê o resumo. Nada de narrar cada arquivo lido.
 */
const NARRATION_HEARTBEAT_MS = 45_000;
let narrating = false;
let narrationTimer: NodeJS.Timeout | null = null;
let narratedError = false;

const stopNarration = (): void => {
  narrating = false;
  narratedError = false;
  if (narrationTimer) clearInterval(narrationTimer);
  narrationTimer = null;
};

const orchestrator = new Orchestrator(broadcast, claude, {
  onFinish: (state, summary) => {
    if (!narrating) return;
    stopNarration();
    if (state === 'cancelled') return;
    const closing =
      state === 'failed'
        ? 'Terminei, mas deu problema no caminho. Dá uma olhada nos blocos.'
        : summary || 'Pronto, terminei.';
    agentSays(closing);
  },
  onError: (text) => {
    // Um aviso por execução: erro em cascata não pode virar ladainha.
    if (!narrating || narratedError) return;
    narratedError = true;
    agentSays(`Esbarrei num erro: ${text.slice(0, 140)}`);
  },
});

const conversation = new Conversation(claude);
let conversationActive = false;
let thinking = false;

let auth: AuthState = { loggedIn: true, checkedAt: 0 };

const publishConversation = (): void =>
  broadcast({
    type: 'conversation.state',
    state: { active: conversationActive, thinking, pending: conversation.pending },
  });

/** Fala e registra — tudo que ele diz passa por aqui. */
function agentSays(text: string): void {
  broadcast({ type: 'conversation.turn', role: 'agent', text });
  broadcast({ type: 'conversation.say', text });
}

/**
 * Uma rodada de conversa.
 *
 * Se existe um plano na mesa, a primeira coisa é ouvir um sim ou um não — sem
 * isso, "pode mandar" viraria um pedido novo e o plano ficaria órfão.
 */
async function converse(text: string, images?: ImageAttachment[]): Promise<void> {
  const said = text.trim();
  if (!said) return;

  broadcast({ type: 'conversation.turn', role: 'user', text: said, images });

  if (conversation.pending) {
    if (soundsLikeYes(said)) return void runPending();
    if (soundsLikeNo(said)) {
      conversation.pending = null;
      publishConversation();
      agentSays('Beleza, cancelei. O que você prefere?');
      return;
    }
  }

  thinking = true;
  publishConversation();
  // O turno de conversa passa pelo mesmo processo do Claude, mas não é
  // execução: silenciamos o orquestrador para o envelope JSON não virar bloco
  // na tela nem resposta no Result.
  orchestrator.muted = true;
  try {
    const reply = await conversation.say(said, images);
    agentSays(reply.say);
  } catch (error) {
    agentSays(`Deu problema aqui: ${(error as Error).message}`);
  } finally {
    orchestrator.muted = false;
    thinking = false;
    publishConversation();
  }
}

/**
 * O "pode ir": o plano combinado vira um workflow de verdade.
 *
 * Antes esse caminho existia só para pedido direto (`prompt.submit`); agora
 * que Talking é o único jeito de pedir algo, o reaproveitamento do Tree
 * (assunto já confirmado entra como contexto pronto, sem o agente investigar
 * tudo de novo) precisa acontecer aqui.
 */
async function runPending(): Promise<void> {
  const prompt = conversation.executionPrompt();
  if (!prompt) return;
  const title = conversation.pending?.title ?? 'Execução combinada';
  conversation.pending = null;
  publishConversation();
  agentSays('Fechado, começando agora. Vou te contando pelo caminho.');

  const remembered = await recall(title).catch(() => []);
  const finalPrompt = remembered.length > 0 ? `${recallBlock(remembered)}${prompt}` : prompt;
  orchestrator.startWorkflow(finalPrompt, title);
  if (remembered.length > 0) {
    agentSays(`Reaproveitando ${remembered.length} assunto(s) que já conhecia: ${remembered.map((item) => item.title).join(', ')}.`);
    void publishTree();
  }

  narrating = true;
  narratedError = false;
  if (narrationTimer) clearInterval(narrationTimer);
  narrationTimer = setInterval(() => {
    if (!narrating) return;
    const action = orchestrator.currentAction;
    agentSays(action ? `Ainda nisso. Agora: ${action.toLowerCase()}.` : 'Ainda trabalhando.');
  }, NARRATION_HEARTBEAT_MS);
  narrationTimer.unref?.();
}

/** Reavalia a credencial perguntando ao CLI. */
async function refreshAuth(reason: string): Promise<AuthState> {
  const next = await checkAuth();
  if (!next.loggedIn) next.reason = 'missing';
  auth = next;
  console.log(`[auth] ${reason}: ${auth.loggedIn ? `ok (${auth.method})` : 'sem credencial'}`);
  broadcast({ type: 'auth.state', auth });
  return auth;
}

/**
 * Um 401 vindo da API é a única prova real de que a credencial morreu.
 *
 * O `claude auth status` continua dizendo `loggedIn: true` com um token
 * vencido — ele só confirma que existe credencial guardada. Então quando a
 * API recusa, marcamos expirado aqui e não perguntamos a opinião do CLI: era
 * exatamente por isso que o aviso não aparecia na tela.
 */
function markExpired(where: string): void {
  if (auth.loggedIn === false && auth.reason === 'expired') return;
  auth = { loggedIn: false, reason: 'expired', checkedAt: Date.now(), method: auth.method };
  console.warn(`[auth] 401 em ${where} — sessão expirada; pedindo login`);
  broadcast({ type: 'auth.state', auth });
}

/**
 * O erro de autenticação chega como texto de resposta, não como exceção.
 * Quando reconhecemos a frase, confirmamos com o CLI e avisamos a tela — que
 * abre o convite para entrar de novo em vez de deixar o erro no log.
 */
claude.on('text', (text: string) => {
  if (looksLikeAuthFailure(text)) markExpired('resposta do agente');
});
claude.on('stderr', (chunk: string) => {
  if (looksLikeAuthFailure(chunk)) markExpired('stderr do agente');
});

async function projectState(): Promise<ProjectState> {
  return {
    path: prefs.projectPath,
    name: projectName(prefs.projectPath),
    recents: prefs.recents,
    exists: await isUsableDirectory(prefs.projectPath),
    shell: { status: shell.status, error: shell.lastError },
    claude: {
      status: claude.status,
      sessionId: claude.sessionId,
      model: claude.model,
      error: claude.lastError,
    },
  };
}

let publishScheduled = false;
/** Vários eventos mudam o estado no mesmo instante; publicamos uma vez só. */
const publishProject = (): void => {
  if (publishScheduled) return;
  publishScheduled = true;
  setTimeout(() => {
    publishScheduled = false;
    void projectState().then((project) => broadcast({ type: 'project.state', project }));
  }, 30);
};

shell.on('status', publishProject);
claude.on('status', publishProject);
claude.on('init', publishProject);

/**
 * Sobe os dois processos na pasta do projeto. É isto que faz a página "já abrir
 * com tudo na sequência": ao carregar, o PowerShell já está aberto no lugar
 * certo e o Claude já está esperando o primeiro pedido.
 */
/** Publica o nível 1 do Tree para todo mundo, com o motivo de estar assim. */
async function publishTree(): Promise<void> {
  broadcast({ type: 'tree.subjects', graph: await subjectGraph(), status: dbState() });
}

async function bootRuntimes(reason: string): Promise<void> {
  const ok = await isUsableDirectory(prefs.projectPath);
  if (!ok) {
    console.warn(`[runtime] pasta inexistente: ${prefs.projectPath}`);
    publishProject();
    return;
  }
  console.log(`[runtime] ${reason} → ${prefs.projectPath}`);
  if (config.shell.autoStart) shell.start(prefs.projectPath);
  if (config.claude.autoStart) claude.start(prefs.projectPath);
  publishProject();
}

/* ------------------------------------------------------------- comandos --- */

async function handle(client: WebSocket, command: ClientCommand): Promise<void> {
  switch (command.type) {
    case 'ping':
      return send(client, { type: 'pong' });

    case 'prompt.submit': {
      const text = command.text.trim();
      if (!text) return;
      if (claude.status === 'stopped' || claude.status === 'error') {
        await bootRuntimes('religando o Claude');
      }

      // Aqui mora a economia: assunto já confirmado entra como contexto pronto,
      // em vez de o agente investigar tudo outra vez.
      const remembered = await recall(text).catch(() => []);
      const prompt = remembered.length > 0 ? `${recallBlock(remembered)}${text}` : text;

      if (!orchestrator.startWorkflow(prompt, text)) {
        send(client, { type: 'error', message: 'O Claude não está de pé. Confira a pasta do projeto.' });
        return;
      }
      if (remembered.length > 0) {
        broadcast({
          type: 'assistant.say',
          speak: false,
          text: `Reaproveitando ${remembered.length} assunto(s) do Tree: ${remembered.map((item) => item.title).join(', ')}.`,
        });
        void publishTree();
      }
      return;
    }

    case 'workflow.cancel':
      stopNarration();
      orchestrator.cancel();
      await bootRuntimes('reabrindo após cancelamento');
      return;

    case 'project.roots': {
      const roots = await listRoots();
      return send(client, {
        type: 'project.listing',
        listing: { path: '', parent: null, entries: roots },
      });
    }

    case 'project.browse': {
      const listing = await listDirectory(command.path);
      return send(client, { type: 'project.listing', listing });
    }

    case 'project.set': {
      if (!(await isUsableDirectory(command.path))) {
        return send(client, { type: 'error', message: `Pasta não encontrada: ${command.path}` });
      }
      prefs = writePrefs({ projectPath: command.path });
      await bootRuntimes('projeto trocado');
      broadcast({
        type: 'assistant.say',
        text: `Projeto trocado para ${projectName(command.path)}. Shell e Claude reabertos nessa pasta.`,
        speak: false,
      });
      return;
    }

    case 'runtime.restart': {
      if (command.target === 'shell' || command.target === 'both') shell.stop();
      if (command.target === 'claude' || command.target === 'both') claude.stop();
      await bootRuntimes('reinício pedido pela interface');
      return;
    }

    case 'conversation.start':
      // Clique duplo (ou dois clientes abertos) não pode render dois "olá".
      // Não reseta a conversa: isto só liga o microfone de mãos livres — o
      // chat escrito no Talking já funcionava e continua valendo o que foi
      // dito antes, plano pendente incluso.
      if (conversationActive) return publishConversation();
      conversationActive = true;
      publishConversation();
      agentSays(`Estou te ouvindo. Comece falando "${wakeWord}".`);
      return;

    case 'conversation.stop':
      // Só desliga o microfone — o Talking continua de pé por texto.
      conversationActive = false;
      publishConversation();
      return;

    case 'conversation.input':
      await converse(command.text, command.images);
      return;

    case 'conversation.confirm':
      if (command.accept) void runPending();
      else {
        conversation.pending = null;
        publishConversation();
      }
      return;

    case 'auth.check':
      await refreshAuth('verificação pedida pela interface');
      return;

    case 'auth.login': {
      // Janela visível: só quando o caminho pelo shell não serve.
      if (command.mode === 'window') {
        try {
          openLoginTerminal(prefs.projectPath);
        } catch (error) {
          send(client, { type: 'error', message: (error as Error).message });
        }
        return;
      }

      // Caminho preferido: o PowerShell que já está aberto na pasta do projeto.
      if (shell.status !== 'ready') {
        shell.start(prefs.projectPath);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      broadcast({ type: 'auth.login.line', line: `> claude auth login --claudeai` });

      const collected: string[] = [];
      const forward = (line: string): void => {
        collected.push(line);
        broadcast({ type: 'auth.login.line', line });
      };

      const result = await loginViaShell(
        shell,
        forward,
        (handler) => {
          shell.on('line', handler);
          return () => shell.off('line', handler);
        },
      );

      const urls = extractUrls([...collected, result.output].join('\n'));
      broadcast({ type: 'auth.login.done', ok: result.ok, urls });
      if (result.ok) {
        await refreshAuth('depois do login');
        if (auth.loggedIn) {
          // O processo antigo ainda segura o token vencido na memória.
          claude.stop();
          await bootRuntimes('credencial renovada');
        }
      }
      return;
    }

    case 'project.pick': {
      console.log('[picker] abrindo o seletor de pastas…');
      try {
        const chosen = await pickFolderNative(prefs.projectPath);
        console.log(`[picker] ${chosen ? `escolhido: ${chosen}` : 'cancelado pelo usuário'}`);
        send(client, { type: 'project.picked', path: chosen });
        if (chosen) await handle(client, { type: 'project.set', path: chosen });
      } catch (error) {
        const message = (error as Error).message;
        console.error('[picker] falhou:', message);
        send(client, { type: 'project.picked', path: null, error: message });
      }
      return;
    }

    case 'artifact.open':
      try {
        openArtifact(command.path, command.reveal);
      } catch (error) {
        send(client, { type: 'error', message: (error as Error).message });
      }
      return;

    case 'tree.list':
      return void publishTree();

    case 'tree.open':
      return send(client, { type: 'tree.detail', detail: await subjectDetail(command.subjectId) });

    case 'knowledge.save': {
      if (!dbReady()) {
        return send(client, {
          type: 'error',
          message: 'O Tree precisa do Postgres. Suba com: docker compose up -d',
        });
      }
      if (claude.status === 'stopped' || claude.status === 'error') {
        return send(client, { type: 'error', message: 'O Claude precisa estar de pé para resumir o assunto.' });
      }

      const graph = await subjectGraph();
      orchestrator.muted = true;
      try {
        const answer = await claude.ask(extractionPrompt(graph.nodes.map((node) => node.slug)));
        const extracted = parseExtraction(answer);
        if (!extracted) {
          return send(client, { type: 'error', message: 'Não consegui extrair um assunto desta conversa.' });
        }
        const saved = await saveSubject(extracted, { projectPath: prefs.projectPath });
        if (!saved) {
          return send(client, { type: 'error', message: 'Falhei ao gravar o assunto.' });
        }
        broadcast({ type: 'knowledge.saved', id: saved.id, title: saved.title });
        broadcast({
          type: 'assistant.say',
          speak: true,
          text: `Guardei no Tree: ${saved.title}. Da próxima vez que alguém pedir algo parecido, isso vai junto como contexto.`,
        });
        await publishTree();
      } catch (error) {
        send(client, { type: 'error', message: `Não deu para guardar: ${(error as Error).message}` });
      } finally {
        orchestrator.muted = false;
      }
      return;
    }

    case 'knowledge.forget':
      await forgetSubject(command.subjectId);
      return void publishTree();

    case 'agent.inspect':
      return; // as setas do momento já são publicadas pelo orquestrador

    default:
      return;
  }
}

/* ---------------------------------------------------------------- servidor -- */

const app = Fastify({ logger: false });

/**
 * Áudio chega como bytes crus. O Fastify não sabe o que fazer com isso por
 * padrão, então ensinamos: guarde o buffer e siga.
 */
app.addContentTypeParser(
  ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'application/octet-stream'],
  { parseAs: 'buffer' },
  (_request, body, done) => done(null, body),
);

/** Fala → texto, pelo Whisper local. */
app.post('/voice/stt', async (request, reply) => {
  const audio = request.body as Buffer;
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    return reply.code(400).send({ error: 'áudio vazio' });
  }
  try {
    const text = await transcribe(audio);
    const wake = matchesWake(text);
    return { text, wake: wake.hit, command: wake.rest };
  } catch (error) {
    return reply.code(503).send({ error: (error as Error).message });
  }
});

/** Texto → WAV, pelo Piper local. */
app.post('/voice/tts', async (request, reply) => {
  const { text } = (request.body ?? {}) as { text?: string };
  if (!text?.trim()) return reply.code(400).send({ error: 'texto vazio' });
  try {
    const wav = await synthesize(text);
    return reply.type('audio/wav').send(wav);
  } catch (error) {
    return reply.code(503).send({ error: (error as Error).message });
  }
});

app.get('/health', async () => ({
  ok: true,
  project: prefs.projectPath,
  shell: shell.status,
  claude: claude.status,
  uptimeMs: Date.now() - startedAt,
}));

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (client) => {
  clients.add(client);

  send(client, {
    type: 'session.hello',
    session: {
      id: claude.sessionId ?? 'local',
      startedAt,
      runtime: config.shell.bin.includes('powershell') ? 'POWERSHELL' : 'SHELL',
      plan: 'Claude Code',
      version: VERSION,
      features: FEATURES,
    },
  });
  orchestrator.syncCatalog();
  void projectState().then((project) => send(client, { type: 'project.state', project }));
  void subjectGraph().then((graph) =>
    send(client, { type: 'tree.subjects', graph, status: dbState() }));
  send(client, { type: 'auth.state', auth });
  send(client, { type: 'voice.health', health: { ...voiceHealth(), wakeWord } });
  send(client, {
    type: 'conversation.state',
    state: { active: conversationActive, thinking, pending: conversation.pending },
  });

  // Primeira aba a conectar acorda os processos.
  if (claude.status === 'stopped' && clients.size === 1) void bootRuntimes('primeira conexão');

  client.on('message', (raw) => {
    let command: ClientCommand;
    try {
      command = JSON.parse(String(raw)) as ClientCommand;
    } catch {
      return;
    }
    void handle(client, command).catch((error) => {
      console.error('[comando] falhou:', error);
      send(client, { type: 'error', message: String(error) });
    });
  });

  client.on('close', () => clients.delete(client));
});

app.server.on('upgrade', (request, socket, head) => {
  if (!request.url?.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
});

/**
 * O consumo de verdade da conta (5h + semana) — o mesmo que o `/usage` do
 * Claude Code mostra. Não é um endpoint oficial, então falha às vezes; quando
 * falha, silenciosamente mantém o último número bom em vez de zerar a tela.
 * Backoff simples: três falhas seguidas e ele espera 10 pulsos (~10 min)
 * antes de tentar de novo, para não insistir contra uma conta sem OAuth
 * (API key pura, por exemplo) ou um 429 do lado da Anthropic.
 */
let usageFailures = 0;
let usageSkipUntil = 0;
let usageTick = 0;
async function refreshAccountUsage(): Promise<void> {
  usageTick += 1;
  if (usageTick < usageSkipUntil) return;
  const account = await fetchAccountUsage();
  if (account) {
    usageFailures = 0;
    orchestrator.setAccountUsage(account);
    return;
  }
  usageFailures += 1;
  if (usageFailures >= 3) usageSkipUntil = usageTick + 10;
}

/**
 * Pulso do painel Status: consumo real da conta, estado do projeto e saúde
 * da voz, tudo a cada minuto — e sozinho, sem precisar de um pedido de verdade.
 */
const heartbeat = setInterval(() => {
  if (clients.size === 0) return;
  void refreshAccountUsage();
  orchestrator.publishUsage();
  publishProject();
  void checkVoice().then((health) =>
    broadcast({ type: 'voice.health', health: { ...health, wakeWord } }));
}, 60_000);

const shutdown = (): void => {
  console.log('\n[server] encerrando…');
  clearInterval(heartbeat);
  stopNarration();
  shell.stop();
  claude.stop();
  void closeDb();
  void app.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// O banco pode subir depois da ferramenta: quando ele aparecer, o Tree acende
// sozinho, sem reiniciar nada.
await refreshAuth('verificação inicial');
await refreshAccountUsage();
await checkVoice();
await initDb((next) => {
  console.log(`[db] estado: ${next}`);
  void publishTree();
});
await app.listen({ port: config.port, host: config.host });
console.log(`[server] IA_Coder ${VERSION} em ws://${config.host}:${config.port}/ws`);
console.log(`[server] projeto: ${prefs.projectPath}`);

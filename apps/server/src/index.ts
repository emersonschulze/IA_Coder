import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  checkAuth, extractUrls, loginViaShell, looksLikeAuthFailure, openLoginTerminal, type AuthState,
} from './auth.js';
import { ClaudeSession } from './claude.js';
import { config } from './config.js';
import { closeDb, dbReady, dbState, initDb } from './db.js';
import { discoverCatalog } from './discovery.js';
import {
  extractionPrompt, forgetSubject, parseExtraction, recall, recallBlock,
  saveSubject, subjectDetail, subjectGraph,
} from './knowledge.js';
import {
  listMcpServers, loginMcpViaShell, openMcpLoginTerminal, permissionModeReachesMcp,
  serverOfTool, serverSlugOfTool,
} from './mcp.js';
import { openArtifact, pickFolderNative } from './picker.js';
import { isUsableDirectory, listDirectory, listRoots, projectName } from './fsbrowser.js';
import { Orchestrator } from './orchestrator.js';
import { readPrefs, writePrefs } from './prefs.js';
import type {
  ClientCommand, ImageAttachment, McpState, ProjectState, ServerEvent,
} from './protocol.js';
import { ShellSession } from './shell.js';
import { Conversation, soundsLikeNo, soundsLikeYes } from './conversation.js';
import { checkVoice, matchesWake, synthesize, transcribe, voiceHealth, wakeWord } from './voice.js';
import { fetchAccountUsage } from './usage.js';

const startedAt = Date.now();
const VERSION = '0.3.0';
/** Comandos que esta versão entende — anunciados no handshake. */
const FEATURES = ['project', 'picker', 'tree', 'knowledge', 'catalog', 'mcp'];
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
 * sinal de vida de vez em quando, fala se der erro, e no fim lê o resumo.
 *
 * O sinal de vida NÃO recita o comando que está rodando. Isso é log de
 * terminal, e ninguém fala assim com outra pessoa: "cd c:/repositorio &&
 * claude plugin list" não diz nada a quem está esperando. Ele conta o TIPO de
 * trabalho — lendo, mexendo em arquivo, rodando coisa — e mais nada.
 */
const NARRATION_HEARTBEAT_MS = 45_000;
/** Passou disto sem nenhum evento, a narração admite que não sabe. */
const SILENCIO_MS = 90_000;
let narrating = false;
let narrationTimer: NodeJS.Timeout | null = null;
let narratedError = false;
let narrationStartedAt = 0;
/** A última frase dita, para nunca repetir duas seguidas. */
let lastPhrase = '';

/**
 * O repertório do sinal de vida.
 *
 * Duas frases alternando viram ruído: em três minutos você já leu as duas e para
 * de prestar atenção — e aí a mensagem perde a única função que tem, que é você
 * saber que ele continua vivo. Cada grupo de ferramenta tem várias falas, e de
 * vez em quando entra uma com graça.
 *
 * Tudo curto e fácil de falar: isto é LIDO EM VOZ ALTA.
 */
const FALAS: Record<string, string[]> = {
  read: [
    'Ainda dando uma olhada no projeto.',
    'Continuo lendo. Esse projeto tem mais arquivo do que parecia.',
    'Seguindo na leitura — já perdi a conta dos arquivos.',
    'Ainda garimpando código por aqui.',
    'Lendo, lendo, lendo. Te aviso quando fizer sentido.',
  ],
  edit: [
    'Ainda mexendo nos arquivos.',
    'Escrevendo. Prometo que compila.',
    'Continuo editando — quase lá.',
    'Mão na massa por aqui.',
  ],
  shell: [
    'Ainda rodando as coisas por aqui.',
    'O terminal está trabalhando. Eu também.',
    'Continuo tocando os comandos.',
    'Rodando comando. O disco que aguente.',
  ],
  web: [
    'Ainda pesquisando.',
    'Continuo procurando lá fora.',
    'Vasculhando a internet — ela não está colaborando muito.',
  ],
  task: [
    'O subagente está nisso. Eu estou de olho.',
    'Deleguei, e agora sou eu que espero. Ironia.',
    'Ainda com o subagente trabalhando.',
    'Passei a bola. Assim que voltar, te conto.',
  ],
  outro: [
    'Ainda nisso.',
    'Continuo trabalhando — te aviso assim que terminar.',
    'Seguindo por aqui.',
    'Nada de novo ainda, mas não é por falta de esforço.',
  ],
};

/** Entram de vez em quando, misturadas às do trabalho. */
const GRACINHAS = [
  'Ainda trabalhando. Um dia isso acaba.',
  'Se você está contando os minutos, saiba que eu também.',
  'O silêncio aqui é de concentração, não de pane.',
  'Continuo. Você pode ir buscar um café, eu seguro as pontas.',
  'Trabalhando duro. Ou dificilmente. Depende do arquivo.',
  'Ainda aqui. Se eu sumir, pode reclamar.',
];

/** Falas que citam o tempo. Só depois que ele já é grande o bastante. */
const DEMORANDO = [
  'Já são {min} minutos nisso. Ainda em pé.',
  '{min} minutos e contando. Não travou, só é grande mesmo.',
  'Faz {min} minutos que estou nessa. Vale a pena, prometo.',
];

/** Como ele conta que está calado há tempo demais. Varia, mas nunca ameniza. */
const SEM_SINAL = [
  'Faz {min} que ele não dá sinal. Pode ser um comando demorado; se quiser parar, use o abortar aqui em cima.',
  'Silêncio de {min} por aqui. Provavelmente um comando pesado — o abortar está na barra de cima se cansar de esperar.',
  '{min} sem nenhuma novidade dele. Não consigo dizer se está pensando ou parado; você decide se espera.',
];

/** A abertura, dita toda vez que você aprova um plano. */
const COMECANDO = [
  'Fechado, começando agora. Vou te contando pelo caminho.',
  'Combinado. Já estou nisso — vou narrando.',
  'Pode deixar comigo. Te aviso o que for acontecendo.',
  'Beleza, mãos à obra.',
  'Tô indo. Se demorar, eu aviso que estou vivo.',
];

/** O fecho, quando ele não tem um resumo próprio para ler. */
const TERMINEI = [
  'Pronto, terminei.',
  'Acabou. Deu certo.',
  'Feito.',
  'Terminado — sem sobressaltos.',
];

/** O fecho quando deu errado. Direto: aqui não é hora de gracinha. */
const DEU_RUIM = [
  'Terminei, mas deu problema no caminho. Dá uma olhada nos blocos.',
  'Parei com erro. Os blocos têm a linha exata do que falhou.',
  'Não consegui concluir. O motivo está no log do bloco.',
];

/**
 * O fecho quando ele encerrou sem fazer nada.
 *
 * Não é sucesso e não é erro: é o agente respondendo do que já tinha em
 * contexto em vez de executar. Some com o "sem sobressaltos", que fazia essa
 * situação parecer normal e deixava você descobrir sozinho, muito depois, que
 * o trabalho não tinha acontecido.
 */
const NAO_FIZ_NADA = [
  'Terminei sem executar nada — respondi do que já tinha em contexto. Se não era isso, me peça de novo sendo específico.',
  'Encerrei sem abrir arquivo nenhum. Se você esperava a análise de verdade, repete o pedido que eu faço.',
  'Fechei o turno sem usar ferramenta nenhuma. Provavelmente entendi como pergunta, não como tarefa — me corrige.',
];

/** Quando você recusa o plano. */
const DEIXA_PRA_LA = [
  'Beleza, deixei de lado. O que você prefere?',
  'Sem problema, cancelei. Me diz o que muda.',
  'Tá bom, engavetei. Como você quer fazer?',
];

/** A última escolhida de CADA lista. */
const ultimaDaLista = new WeakMap<string[], string>();

/**
 * Sorteia sem repetir.
 *
 * Duas memórias, e as duas são necessárias: a última frase dita no geral (para
 * não repetir de um pulso para o outro) e a última de cada lista (senão a mesma
 * abertura sai em duas execuções seguidas, porque entre elas passou um fecho).
 */
function sortear(lista: string[]): string {
  const anterior = ultimaDaLista.get(lista);
  const opcoes = lista.filter((frase) => frase !== anterior && frase !== lastPhrase);
  const escolhida = opcoes[Math.floor(Math.random() * opcoes.length)]
    ?? lista.find((frase) => frase !== anterior)
    ?? lista[0];
  ultimaDaLista.set(lista, escolhida);
  lastPhrase = escolhida;
  return escolhida;
}

const plural = (n: number, um: string, muitos: string): string =>
  `${n} ${n === 1 ? um : muitos}`;

/** O que dizer quando ele ainda está trabalhando, sem soletrar comando. */
function stillWorking(): string {
  // Silêncio longo não é 'ainda trabalhando': pode ser um comando demorado ou
  // pode ser que ele parou. Fingir normalidade aqui é o que faz você olhar para
  // uma tela parada sem saber se vale a pena esperar.
  const quieto = orchestrator.lastEventAt ? Date.now() - orchestrator.lastEventAt : 0;
  if (quieto > SILENCIO_MS) {
    const minutos = plural(Math.round(quieto / 60_000), 'minuto', 'minutos');
    return sortear(SEM_SINAL).replace('{min}', minutos);
  }

  const minutos = narrationStartedAt ? Math.floor((Date.now() - narrationStartedAt) / 60_000) : 0;
  const sorte = Math.random();

  // De três em três voltas, mais ou menos, ele sai do script.
  if (sorte < 0.22) return sortear(GRACINHAS);
  if (minutos >= 3 && sorte < 0.38) {
    return sortear(DEMORANDO).replace('{min}', String(minutos));
  }
  return sortear(FALAS[orchestrator.currentSkill] ?? FALAS.outro);
}

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
    /*
     * "Terminado — sem sobressaltos" é uma afirmação, e afirmar sucesso quando
     * o agente encerrou sem usar uma ferramenta sequer é mentir para quem está
     * esperando. Sem resumo E sem trabalho, o fecho diz isso na cara.
     */
    const closing =
      state === 'failed' ? sortear(DEU_RUIM)
      : summary ? summary
      : orchestrator.didWork ? sortear(TERMINEI)
      : sortear(NAO_FIZ_NADA);
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

/**
 * Os servidores MCP e se dá para usar cada um.
 *
 * Nasce vazio e `reachable` já resolvido: o modo de permissão é decisão nossa,
 * conhecida antes de perguntar qualquer coisa ao CLI, e é a causa mais comum de
 * "o Jira não carrega".
 */
let mcp: McpState = {
  servers: [],
  checkedAt: 0,
  checking: false,
  reachable: permissionModeReachesMcp(config.claude.permissionMode),
  permissionMode: config.claude.permissionMode,
  blocked: null,
};

const publishMcp = (): void => broadcast({ type: 'mcp.state', mcp });

const publishConversation = (): void =>
  broadcast({
    type: 'conversation.state',
    state: { active: conversationActive, thinking, pending: conversation.pending },
  });

/**
 * Fala e registra — tudo que ele diz passa por aqui.
 *
 * Os dois eventos carregam coisas diferentes de propósito: `turn` é o que fica
 * ESCRITO na conversa, e vai inteiro; `say` é o que será LIDO em voz alta, e é
 * curto. Enquanto era o mesmo texto, a resposta escrita herdava o limite da
 * voz e aparecia cortada no meio da frase.
 */
function agentSays(say: string, full?: string): void {
  broadcast({ type: 'conversation.turn', role: 'agent', text: full?.trim() || say });
  broadcast({ type: 'conversation.say', text: say });
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
      agentSays(sortear(DEIXA_PRA_LA));
      return;
    }
  }

  thinking = true;
  publishConversation();
  // O turno de conversa passa pelo mesmo processo do Claude e não é execução —
  // mas ler o projeto para conseguir responder É trabalho, e trabalho aparece
  // no centro. O que fica de fora é só o texto, que neste turno é um envelope
  // JSON, e o resumo, que já vai pelo Talking.
  orchestrator.investigate(said);
  try {
    const reply = await conversation.say(said, images);
    agentSays(reply.say, reply.text);
  } catch (error) {
    agentSays(`Deu problema aqui: ${(error as Error).message}`);
  } finally {
    orchestrator.resume();
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
  agentSays(sortear(COMECANDO));

  const remembered = await recall(title).catch(() => []);
  const finalPrompt = remembered.length > 0 ? `${recallBlock(remembered)}${prompt}` : prompt;
  orchestrator.startWorkflow(finalPrompt, title);
  if (remembered.length > 0) {
    agentSays(`Reaproveitando ${remembered.length} assunto(s) que já conhecia: ${remembered.map((item) => item.title).join(', ')}.`);
    // A tela precisa saber DE QUAIS assuntos esta análise nasceu: é o que faz o
    // botão oferecer "Atualizar «assunto»" em vez de criar um duplicado.
    broadcast({
      type: 'knowledge.reused',
      subjects: remembered.map((item) => ({ id: item.id, title: item.title })),
    });
    void publishTree();
  }
  else broadcast({ type: 'knowledge.reused', subjects: [] });

  narrating = true;
  narratedError = false;
  narrationStartedAt = Date.now();
  lastPhrase = '';
  if (narrationTimer) clearInterval(narrationTimer);
  narrationTimer = setInterval(() => {
    if (!narrating) return;
    agentSays(stillWorking());
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

/**
 * Reavalia os servidores MCP perguntando ao CLI.
 *
 * Demora: o `claude mcp list` faz health check em cada servidor, e com uma
 * dúzia de conectores isso passa de dez segundos. Por isso a tela recebe
 * `checking: true` antes e a lista depois — em vez de piscar vazia enquanto
 * espera.
 */
let mcpScan: Promise<McpState> | null = null;

async function refreshMcp(reason: string): Promise<McpState> {
  // Duas varreduras ao mesmo tempo não trazem nada de novo e custam dois health
  // checks: quem chegar durante uma em andamento espera o resultado dela.
  if (mcpScan) return mcpScan;
  mcpScan = scanMcp(reason).finally(() => { mcpScan = null; });
  return mcpScan;
}

async function scanMcp(reason: string): Promise<McpState> {
  mcp = { ...mcp, checking: true, error: undefined };
  publishMcp();
  try {
    const servers = await listMcpServers(prefs.projectPath);
    const semAuth = servers.filter((server) => server.status === 'needs-auth').length;
    console.log(`[mcp] ${reason}: ${servers.length} servidor(es), ${semAuth} sem credencial`);
    mcp = { ...mcp, servers, checkedAt: Date.now(), checking: false };
  } catch (error) {
    console.warn('[mcp] não consegui listar:', (error as Error).message);
    mcp = { ...mcp, checking: false, checkedAt: Date.now(), error: (error as Error).message };
  }
  publishMcp();
  return mcp;
}

/**
 * Uma ferramenta de MCP que morreu na porta.
 *
 * Em modo -p a negação não vira exceção: o agente escreve "foi bloqueada" na
 * resposta e a vida segue, e você fica achando que o servidor está fora do ar.
 * Aqui separamos as duas causas e mandamos a certa para a tela — é `blocked`
 * que faz o popup abrir sozinho, em vez de esperar você ir procurar.
 */
claude.on('denied', ({ tool }: { tool: string }) => {
  const slug = serverSlugOfTool(tool);
  if (!slug) return;
  const server = serverOfTool(tool, mcp.servers);
  const reason = server?.status === 'needs-auth' ? 'needs-auth' : 'permission';
  console.warn(`[mcp] ${tool} barrada (${reason})`);
  mcp = { ...mcp, blocked: { server: server?.name ?? slug, tool, reason } };
  publishMcp();
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

/**
 * Quem está instalado nesta máquina — plugins, `.claude` do projeto e o seu.
 *
 * Roda a cada troca de projeto porque plugin de escopo "project" só vale onde
 * foi instalado: o catálogo é do projeto aberto, não da ferramenta.
 */
async function refreshCatalog(): Promise<void> {
  try {
    const catalog = await discoverCatalog(prefs.projectPath);
    orchestrator.setCatalog(catalog);
    console.log(`[catálogo] ${catalog.agents.length} agente(s) e ${catalog.skills.length} skill(s) instaladas`);
  } catch (error) {
    console.warn('[catálogo] não consegui varrer o disco:', (error as Error).message);
  }
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
  void refreshCatalog();
  // Servidor MCP de escopo `project` só existe na pasta onde foi declarado:
  // trocar de projeto troca a lista.
  void refreshMcp('projeto trocado');
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

    case 'workflow.cancel': {
      /*
       * Abortar tem de parar TRÊS coisas, e antes parava uma.
       *
       * 1. O agente — e a árvore dele. No Windows o `claude` roda dentro de um
       *    `cmd.exe`; matar só o `cmd` deixava o agente e os subagentes vivos,
       *    trabalhando às escuras depois de a tela dizer que tinha parado.
       * 2. O PowerShell e o que ele estiver rodando. Ninguém parava o shell:
       *    um `dotnet build` disparado pelo agente seguia até o fim.
       * 3. O turno de conversa que estivesse esperando resposta — senão o
       *    Talking ficava "pensando" para sempre, porque o `result` que ele
       *    aguardava nunca mais viria.
       */
      stopNarration();
      const havia = thinking || orchestrator.didWork;
      orchestrator.cancel();
      shell.stop();

      // O turno pendente morre junto com o processo: o `converse` recebe a
      // rejeição e libera o "pensando" sozinho, mas se não havia turno nenhum
      // em voo ninguém zeraria isto.
      thinking = false;
      conversation.pending = null;
      publishConversation();

      conversation.note('user', 'Abortar.');
      broadcast({ type: 'conversation.turn', role: 'user', text: '■ Abortar' });
      agentSays(havia
        ? 'Ação interrompida por você. Parei o agente e o terminal no meio do caminho — o que já foi feito em disco continua feito.'
        : 'Ação interrompida por você. Não havia nada em andamento.');

      await bootRuntimes('reabrindo após o abortar');
      return;
    }

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

    case 'conversation.confirm': {
      // O clique é uma resposta como qualquer outra: entra na conversa como
      // fala sua. Sem isso o plano saía do ar e ninguém via quem disse sim.
      if (!conversation.pending) return;
      const said = command.accept ? 'Pode ir.' : 'Agora não.';
      conversation.note('user', said);
      broadcast({ type: 'conversation.turn', role: 'user', text: said });

      if (command.accept) {
        void runPending();
        return;
      }
      conversation.pending = null;
      publishConversation();
      agentSays(sortear(DEIXA_PRA_LA));
      return;
    }

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

    case 'mcp.check':
      await refreshMcp('verificação pedida pela interface');
      return;

    case 'mcp.dismiss':
      // Você fechou o aviso: ele não volta sozinho até a próxima ferramenta
      // barrada. Insistir aqui viraria um popup que reabre a cada resposta.
      mcp = { ...mcp, blocked: null };
      publishMcp();
      return;

    case 'mcp.login': {
      const name = command.server?.trim();
      if (!name) return send(client, { type: 'error', message: 'qual servidor MCP?' });

      // Janela visível: só quando o caminho pelo shell não serve.
      if (command.mode === 'window') {
        try {
          openMcpLoginTerminal(name, prefs.projectPath);
        } catch (error) {
          send(client, { type: 'error', message: (error as Error).message });
        }
        return;
      }

      if (shell.status !== 'ready') {
        shell.start(prefs.projectPath);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      broadcast({ type: 'mcp.login.line', server: name, line: `> claude mcp login "${name}"` });

      const collected: string[] = [];
      const forward = (line: string): void => {
        collected.push(line);
        broadcast({ type: 'mcp.login.line', server: name, line });
      };

      const result = await loginMcpViaShell(
        name,
        shell,
        forward,
        (handler) => {
          shell.on('line', handler);
          return () => shell.off('line', handler);
        },
      );

      const urls = extractUrls([...collected, result.output].join('\n'));
      broadcast({ type: 'mcp.login.done', server: name, ok: result.ok, urls });
      mcp = { ...mcp, blocked: null };
      // O processo do Claude carrega a lista de servidores do boot: sem
      // reabrir, a credencial nova só valeria na próxima vez que a ferramenta
      // subisse — que é exatamente a queixa de "loguei e continua sem acesso".
      if (result.ok) {
        claude.stop();
        // `bootRuntimes` já revarre os servidores — não peça duas vezes, cada
        // varredura é um health check em toda a lista.
        await bootRuntimes('credencial de MCP renovada');
      } else {
        await refreshMcp('depois de um login de MCP que falhou');
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
      orchestrator.mode = 'silent';
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
        broadcast({
          type: 'knowledge.saved', id: saved.id, title: saved.title, created: saved.created,
        });
        agentSays(saved.created
          ? `Guardei no Tree: ${saved.title}. Da próxima vez que alguém pedir algo parecido, isso vai junto como contexto.`
          : `Atualizei no Tree: ${saved.title}. O resumo e a stack dele agora são os desta análise.`);
        await publishTree();
      } catch (error) {
        send(client, { type: 'error', message: `Não deu para guardar: ${(error as Error).message}` });
      } finally {
        orchestrator.resume();
      }
      return;
    }

    case 'knowledge.discard':
      // Nada a apagar: a análise nunca chegou ao banco. O que sai é o convite
      // de guardar — e a tela é quem sabe que ele estava lá.
      broadcast({ type: 'knowledge.reused', subjects: [] });
      return;

    case 'knowledge.manual': {
      if (!dbReady()) {
        return send(client, {
          type: 'error',
          message: 'O Tree precisa do Postgres. Suba com: docker compose up -d',
        });
      }
      const title = command.title?.trim();
      const summary = command.summary?.trim();
      if (!title || !summary) {
        return send(client, { type: 'error', message: 'Preciso do nome do nó e do contexto.' });
      }

      // Sem `claude.ask` aqui de propósito: este caminho existe para funcionar
      // quando o agente não está de pé, ou quando você simplesmente sabe o que
      // quer guardar melhor do que ele.
      const saved = await saveSubject(
        { title, slug: title, summary, tags: command.tags ?? [] },
        { projectPath: prefs.projectPath },
      );
      if (!saved) return send(client, { type: 'error', message: 'Falhei ao gravar o assunto.' });

      broadcast({
        type: 'knowledge.saved', id: saved.id, title: saved.title, created: saved.created,
      });
      agentSays(saved.created
        ? `Guardei no Tree: ${saved.title}. Foi você que escreveu, então vai inteiro do jeito que está.`
        : `Atualizei no Tree: ${saved.title}. O resumo dele agora é o que você escreveu.`);
      await publishTree();
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
  send(client, { type: 'mcp.state', mcp });
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
// Sem `await`: o health check de uma dúzia de conectores leva mais tempo do que
// o razoável para segurar a porta 8787 fechada. A tela recebe a lista quando
// ela ficar pronta.
void refreshMcp('varredura inicial');
await refreshCatalog();
await refreshAccountUsage();
await checkVoice();
await initDb((next) => {
  console.log(`[db] estado: ${next}`);
  void publishTree();
});
await app.listen({ port: config.port, host: config.host });
console.log(`[server] IA_Coder ${VERSION} em ws://${config.host}:${config.port}/ws`);
console.log(`[server] projeto: ${prefs.projectPath}`);

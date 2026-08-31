import { randomUUID } from 'node:crypto';
import type { ClaudeSession, RateLimit, ToolResult, ToolUse, TurnResult } from './claude.js';
import {
  MAIN_AGENT, SKILLS, artifactFromTool, bareName, describeTool, installedAgent, installedSkill,
  folderOf, isDelegation, normalizeDir, skillCardForTool, skillForTool, skillFromPath,
  skillFromText, subAgent, truncate,
} from './catalog.js';
import type { DiscoveredCatalog } from './discovery.js';
import type {
  Agent, Artifact, Block, LogEntry, ServerEvent, Skill, Usage, Workflow,
} from './protocol.js';
import type { AccountUsage } from './usage.js';

type Emit = (event: ServerEvent) => void;

/** O quanto de um turno chega à tela. Ver `Orchestrator.mode`. */
export type OrchestratorMode = 'full' | 'investigation' | 'silent';

/** Ganchos para quem quiser narrar a execução em voz alta. */
export interface OrchestratorHooks {
  onFinish?: (state: 'done' | 'failed' | 'cancelled', summary: string) => void;
  onError?: (text: string) => void;
}

/**
 * Traduz o que o Claude Code faz para a linguagem da tela.
 *
 * Cada uso de ferramenta vira: uma linha de log no bloco do agente, a skill
 * correspondente acesa, e um par de setas (agente → bloco, agente → skill).
 * Quando ele delega com a ferramenta Task, nasce um bloco novo para o subagente.
 */
export class Orchestrator {
  private agents: Agent[] = [{ ...MAIN_AGENT }];
  private skills: Skill[] = SKILLS.map((skill) => ({ ...skill }));
  private blocks = new Map<string, Block>();
  private activeLinks: string[] = [];
  private artifacts: Artifact[] = [];
  private workflow: Workflow | null = null;
  private toolCount = 0;
  private usage: Usage = {
    tokensUsed: 0, tokensLimit: 0, contextPct: 0, costUsd: 0, plan: 'Claude Code',
    updatedAt: Date.now(),
  };
  /**
   * Quanto do trabalho vai para a tela.
   *
   * - "full": execução de verdade, depois do seu "pode ir". Tudo aparece.
   * - "investigation": turno de conversa. O agente lê o projeto para conseguir
   *   responder, e isso É trabalho: vira bloco, seta e skill acesa no centro.
   *   Só o TEXTO fica de fora, porque nesse turno ele é um envelope JSON.
   * - "silent": turno interno (extrair o assunto para o Tree). Nada aparece.
   */
  mode: OrchestratorMode = 'full';
  /** Título do turno de conversa, usado se ele decidir investigar. */
  private investigationTitle: string | null = null;

  /** Nome chamado pelo Claude → id do cartão na tela. */
  private installedAgents = new Map<string, string>();
  private installedSkills = new Map<string, string>();
  /** Pasta em disco de cada skill → id dela. Veja `skillFromPath`. */
  private skillDirs = new Map<string, string>();
  /**
   * NOME da pasta de cada skill → id dela. Veja `skillFromText`.
   *
   * O caminho absoluto não basta: a mesma skill existe em duas cópias — o cache
   * do plugin, que a descoberta indexa, e o repo-fonte, que é de onde o agente
   * costuma ler. O nome da pasta é o que as duas têm em comum.
   */
  private skillFolders = new Map<string, string>();

  /**
   * As delegações ABERTAS, indexadas pelo id do `Task` que as abriu.
   *
   * Precisa ser um mapa, não um slot: o Claude Code dispara vários `Task` na
   * mesma leva ("fan out to the specialists in parallel") e os quatro correm ao
   * mesmo tempo. Com um slot só, cada nova delegação apagava a anterior — e daí
   * saíam os dois defeitos que se viam na tela:
   *
   * 1. o `tool_result` dos subagentes anteriores não casava mais com o slot, e
   *    o bloco deles ficava "executando" para sempre, marcando "sem sinal há
   *    14 minutos" enquanto o trabalho já tinha sido entregue;
   * 2. tudo o que os quatro faziam era creditado ao último que delegou, então
   *    os outros três ficavam com o bloco vazio e "sem skill no momento".
   *
   * Quem diz de quem é cada evento é o `parent_tool_use_id` do stream, não a
   * ordem de chegada — em paralelo, ordem não significa nada.
   */
  private delegations = new Map<string, { agentId: string; blockId: string }>();

  /**
   * A skill que cada agente está usando AGORA. Por agente, não por delegação.
   *
   * Um agente não tem uma skill: o dev-qa tem sete, e ao longo de uma tarefa
   * passa por várias — abre `planejar-e2e/SKILL.md` e gera os cenários, depois
   * abre `criar-teste-e2e/SKILL.md` e implementa. O que a tela precisa mostrar é
   * a corrente, trocando quando ele troca.
   *
   * Por AGENTE porque com quatro especialistas em paralelo são quatro skills
   * correntes ao mesmo tempo, cada uma na linha do seu dono — e três coisas
   * dependem disso de forma independente: o cartão do agente, o cartão do bloco
   * e o brilho no painel Skill.
   *
   * Ela rege até ser trocada: enquanto o dev-qa lê dez arquivos de código para
   * cumprir a `planejar-e2e`, a skill em curso continua sendo `planejar-e2e`.
   * Cair para "Leitura" no primeiro arquivo seria trocar o QUE ele está fazendo
   * pelo COMO.
   */
  private reigning = new Map<string, string>();

  /** Último texto que o agente escreveu — vira o resumo falado no fim. */
  private lastText = '';
  /**
   * Quando o agente deu sinal de vida pela última vez.
   *
   * "Está demorando" e "travou" são coisas diferentes, e sem esta marca a tela
   * não consegue dizer qual das duas está acontecendo.
   */
  lastEventAt = 0;
  /** O que está sendo feito agora — texto técnico, para o log do bloco. */
  currentAction = '';
  /**
   * O agente chegou a fazer alguma coisa neste turno?
   *
   * Serve para a narração não dizer "terminado, sem sobressaltos" quando ele
   * encerrou sem usar uma ferramenta sequer — que é falha, não sucesso.
   */
  get didWork(): boolean {
    return this.toolCount > 0;
  }
  /**
   * O GRUPO de ferramenta em uso (read, edit, shell…).
   *
   * É o que a narração falada usa: dá para dizer "ainda lendo o projeto" sem
   * recitar o comando, que é log de terminal e não conversa.
   */
  currentSkill = '';

  constructor(
    private readonly emit: Emit,
    private readonly claude: ClaudeSession,
    private readonly hooks: OrchestratorHooks = {},
  ) {
    this.wire();
  }

  /* ------------------------------------------------------------- catálogo -- */

  /** Reenvia o consumo — usado pelo pulso de atualização do painel Status. */
  publishUsage(): void {
    this.emit({ type: 'usage', usage: this.usage });
  }

  /**
   * O consumo de verdade da conta — 5h e semana — chegou da Anthropic.
   *
   * É diferente do que `onResult`/`onRateLimit` juntam: aqueles são o gasto
   * DESTA sessão do servidor. Isto é o total da conta, o mesmo número que o
   * `/usage` do Claude Code mostra, e é o que o painel Status deve exibir.
   */
  setAccountUsage(account: AccountUsage): void {
    this.usage = {
      ...this.usage,
      windowPct: account.fiveHourPct,
      windowResetsAt: account.fiveHourResetsAt ?? undefined,
      weekPct: account.weekPct,
      weekResetsAt: account.weekResetsAt ?? undefined,
      updatedAt: Date.now(),
    };
    this.emit({ type: 'usage', usage: this.usage });
  }

  /**
   * O catálogo do disco chegou: agentes e skills que existem de verdade nesta
   * máquina entram na tela ao lado dos grupos de ferramenta.
   *
   * Quem já estava na lista mantém o estado — trocar o catálogo no meio de uma
   * execução não pode apagar o agente que está trabalhando.
   */
  setCatalog(catalog: DiscoveredCatalog): void {
    const keptAgent = new Map(this.agents.map((agent) => [agent.id, agent]));
    const keptSkill = new Map(this.skills.map((skill) => [skill.id, skill]));

    const discovered = catalog.agents.map((entry, index) => installedAgent(entry, index));
    const subagents = this.agents.filter((agent) => agent.id.startsWith('sub:'));
    this.agents = [
      keptAgent.get(MAIN_AGENT.id) ?? { ...MAIN_AGENT },
      ...discovered.map((agent) => keptAgent.get(agent.id) ?? agent),
      ...subagents,
    ];

    this.skills = [
      ...SKILLS.map((skill) => keptSkill.get(skill.id) ?? { ...skill }),
      ...catalog.skills.map(installedSkill).map((skill) => keptSkill.get(skill.id) ?? skill),
    ];

    this.installedAgents = new Map(this.agents
      .filter((agent) => agent.source)
      .map((agent) => [bareName(agent.name), agent.id]));
    this.installedSkills = new Map(this.skills
      .filter((skill) => skill.kind === 'skill')
      .map((skill) => [bareName(skill.name), skill.id]));
    this.skillDirs = new Map(catalog.skills
      .filter((entry) => entry.dir)
      .map((entry) => [normalizeDir(entry.dir), entry.id]));
    this.skillFolders = new Map(catalog.skills
      .filter((entry) => entry.dir && folderOf(entry.dir))
      .map((entry) => [folderOf(entry.dir), entry.id] as [string, string]));

    this.emit({ type: 'agents.sync', agents: this.agents });
    this.emit({ type: 'skills.sync', skills: this.skills });
  }

  syncCatalog(): void {
    this.emit({ type: 'agents.sync', agents: this.agents });
    this.emit({ type: 'skills.sync', skills: this.skills });
    this.emit({ type: 'archives.sync', archives: this.artifacts });
    this.emit({ type: 'usage', usage: this.usage });
    if (this.workflow) {
      this.lastEventAt = Date.now();
    this.emit({ type: 'workflow.started', workflow: this.workflow });
      this.blocks.forEach((block) => this.emit({ type: 'block.upsert', block }));
    }
  }

  /* ------------------------------------------------------------- workflow -- */

  /**
   * @param prompt  o que vai para o agente (pode levar o contexto do Tree junto)
   * @param title   o que o usuário digitou, que é o que aparece na tela
   */
  startWorkflow(prompt: string, title = prompt): boolean {
    if (!this.claude.send(prompt)) return false;
    /*
     * Uma execução NUNCA é investigação, e não dá para confiar em quem chama
     * para garantir isso.
     *
     * Em modo diferente de "full" o `onText` descarta o que o agente escreve —
     * o resumo final some, `onFinish` recebe vazio e a narração encerra com
     * "Terminado — sem sobressaltos" enquanto a resposta de verdade foi jogada
     * fora. Quem dispara a execução é quem sabe que é execução; então é aqui
     * que o modo se resolve.
     */
    this.mode = 'full';
    this.investigationTitle = null;
    this.openWorkflow(title, 'execution');
    this.setAgentState('claude', 'working', 0);
    this.blockFor('claude');
    return true;
  }

  /**
   * Um turno de conversa começou.
   *
   * O workflow NÃO nasce aqui: nasce na primeira ferramenta que ele usar. Quem
   * só conversa não merece um workflow vazio piscando no centro; quem sai lendo
   * o projeto merece ver isso acontecendo.
   */
  investigate(title: string): void {
    this.mode = 'investigation';
    this.investigationTitle = title;
  }

  /** Fim do turno de conversa: volta ao normal. */
  resume(): void {
    this.mode = 'full';
    this.investigationTitle = null;
  }

  private openWorkflow(title: string, kind: 'execution' | 'investigation'): void {
    this.clearLinks();
    this.blocks.clear();
    this.toolCount = 0;
    this.delegations.clear();
    this.reigning.clear();
    this.workflow = {
      id: `wf_${Date.now().toString(36)}`,
      title,
      state: 'running',
      step: 0,
      totalSteps: 0,
      progress: 0,
      startedAt: Date.now(),
      kind,
    };
    this.emit({ type: 'workflow.started', workflow: this.workflow });
  }

  /**
   * Abortar de verdade: derruba o agente e encerra o que estava na tela.
   *
   * Não depende de existir um workflow aberto. Um turno de conversa que ainda
   * não usou ferramenta nenhuma não tem workflow — e era justamente o caso em
   * que o abortar não fazia nada, deixando o agente trabalhando sozinho.
   */
  cancel(): void {
    this.claude.stop('você abortou a execução');
    this.finish('cancelled');
  }

  /* --------------------------------------------------------------- ligação -- */

  private wire(): void {
    this.claude.on('text', (text: string) => this.onText(text));
    this.claude.on('tool', (tool: ToolUse) => this.onTool(tool));
    this.claude.on('tool_result', (result: ToolResult) => this.onToolResult(result));
    this.claude.on('result', (result: TurnResult) => this.onResult(result));
    this.claude.on('rate_limit', (limit: RateLimit) => this.onRateLimit(limit));
  }

  private onText(text: string): void {
    this.lastEventAt = Date.now();
    if (this.mode !== 'full') return;
    const blockId = this.blockFor('claude').id;
    const clean = text.replace(/\s+/g, ' ').trim();
    this.lastText = clean;
    this.log(blockId, 'info', truncate(clean, 300));
    // Só o texto escrito. Quem decide o que é falado é a narração, no index —
    // ter dois narradores foi o que fazia a voz atropelar a si mesma.
    this.emit({ type: 'assistant.say', text: truncate(text, 400), speak: false });
  }

  private onTool(tool: ToolUse): void {
    if (this.mode === 'silent') return;
    this.lastEventAt = Date.now();
    if (!this.workflow && this.mode === 'investigation') {
      this.openWorkflow(this.investigationTitle ?? 'Investigando o projeto', 'investigation');
      this.setAgentState('claude', 'working', 0);
    }
    const delegou = isDelegation(tool.name);
    /*
     * De quem é este evento?
     *
     * O `parent_tool_use_id` responde sem ambiguidade: veio de dentro de um
     * `Task`, é do subagente daquele `Task`; veio sem pai, é do principal. Antes
     * a resposta era "de quem delegou por último", que só acerta quando existe
     * uma delegação de cada vez — e o Claude Code raramente delega assim.
     */
    const owner = tool.parentToolUseId ? this.delegations.get(tool.parentToolUseId) : undefined;
    const agentId = delegou
      ? this.agentForDelegation(String(tool.input.subagent_type ?? 'agente'))
      : owner?.agentId ?? 'claude';

    /*
     * A skill de verdade, quando existe uma, é mais informativa do que o grupo
     * de ferramentas — é ela que ganha a seta e o brilho.
     *
     * Dois caminhos, porque há dois jeitos de usar uma skill nesta máquina:
     * chamar a ferramenta `Skill`, e ABRIR o `SKILL.md` dela. O segundo não é
     * gambiarra: é o que os AGENT.md do JuntoAgents mandam fazer ("antes de
     * usar uma skill, leia o arquivo correspondente"). Enquanto só o primeiro
     * contava, o painel jurava que nenhum agente usava skill nenhuma.
     */
    const invoked = tool.name === 'Skill'
      ? this.installedSkills.get(bareName(String(tool.input.skill ?? tool.input.name ?? '')))
      : this.skillBeingUsed(tool);
    const skillId = invoked ?? skillCardForTool(tool.name);
    const block = this.blockFor(agentId);
    const action = describeTool(tool.name, tool.input);

    this.toolCount += 1;
    // Descobriu uma skill nova? Ela passa a reger este agente daqui em diante,
    // substituindo a anterior — é assim que a troca de skill aparece na tela.
    if (invoked) this.reigning.set(agentId, invoked);
    const emCurso = this.reigning.get(agentId) ?? skillId;
    this.setAgentState(agentId, 'working', this.guessProgress(), emCurso);

    if (delegou) {
      // Delegar é ação de QUEM delega: a linha fica no bloco do principal, que
      // passa a "blocked" — ele não está trabalhando, está esperando. O bloco do
      // subagente abre com a tarefa que recebeu, não com o ato de delegá-la.
      const principal = this.blockFor('claude');
      this.log(principal.id, 'info', action);
      this.setAgentState('claude', 'blocked', this.guessProgress());
      this.delegations.set(tool.id, { agentId, blockId: block.id });
      this.showWaiting();
      this.patchBlock(block.id, {
        action: truncate(String(tool.input.description ?? 'Assumindo a tarefa'), 70),
        state: 'running',
      });
    }

    /*
     * Quem acende é a skill EM CURSO, não o grupo de ferramenta.
     *
     * PowerShell é ferramenta do sistema, não habilidade: se o dev-qa está
     * executando a `planejar-e2e` e por acaso usa bash para isso, quem tem de
     * aparecer é a skill. O grupo de ferramenta continua acendendo — mas só
     * quando não há skill nenhuma regendo aquele agente, que é quando ele é, de
     * fato, a melhor resposta para "o que está sendo feito".
     */
    this.setSkillsInUse(this.litSkills(emCurso));
    this.currentAction = action;
    this.currentSkill = skillForTool(tool.name);
    if (!delegou) {
      this.patchBlock(block.id, {
        action, skillId: emCurso, state: 'running', progress: this.guessProgress(),
      });
    }
    // "Delegando para explore" é ação de quem delega, e já foi registrada no
    // bloco do principal ali em cima. Repetir aqui punha o subagente delegando
    // para si mesmo no próprio log — a primeira linha do cartão dele era um
    // evento que ele não viveu.
    if (!delegou) this.log(block.id, 'info', action);
    this.focusLinks(agentId, block.id, skillId, tool.name);

    const artifact = artifactFromTool(tool.name, tool.input);
    if (artifact) {
      const entry: Artifact = {
        id: randomUUID(), name: artifact.name, kind: artifact.kind,
        href: artifact.path, createdAt: Date.now(),
      };
      this.artifacts = [entry, ...this.artifacts].slice(0, 100);
      this.emit({ type: 'block.artifact', blockId: block.id, artifact: entry });
      this.emit({ type: 'archive.added', archive: entry });
    }

    if (this.workflow) {
      this.workflow.step = this.toolCount;
      this.workflow.totalSteps = Math.max(this.workflow.totalSteps, this.toolCount);
      this.workflow.progress = this.guessProgress();
      this.emit({ type: 'workflow.updated', patch: {
        id: this.workflow.id, step: this.workflow.step,
        totalSteps: this.workflow.totalSteps, progress: this.workflow.progress,
      }});
    }
  }

  /**
   * Ele está abrindo o `SKILL.md` de alguma skill instalada?
   *
   * É o sinal mais forte de skill em uso nesta máquina, porque é literalmente o
   * que o AGENT.md do JuntoAgents manda o agente fazer: "antes de usar uma
   * skill, leia o arquivo correspondente".
   *
   * Dois jeitos de ler, e os dois contam. Olhar só o `file_path` da ferramenta
   * `Read` deixava passar o caso mais comum na prática — `cat ".../SKILL.md"`
   * pelo Bash —, e aí o painel mostrava "Shell" no lugar da skill: a ferramenta
   * do sistema roubando o crédito do trabalho.
   */
  private skillBeingUsed(tool: ToolUse): string | undefined {
    if (this.skillFolders.size === 0) return undefined;

    if (tool.name === 'Read' || tool.name === 'NotebookRead') {
      const path = tool.input.file_path ?? tool.input.path ?? tool.input.notebook_path;
      if (typeof path !== 'string' || !path) return undefined;
      // Caminho exato primeiro: se ele está dentro de uma pasta que indexamos,
      // não há ambiguidade. O nome da pasta é o plano B, para a outra cópia.
      return skillFromPath(path, this.skillDirs)
        ?? skillFromText(path, this.skillFolders)
        ?? undefined;
    }

    if (tool.name === 'Bash' || tool.name === 'PowerShell') {
      const command = tool.input.command;
      if (typeof command !== 'string') return undefined;
      return skillFromText(command, this.skillFolders) ?? undefined;
    }

    return undefined;
  }

  private onToolResult(result: ToolResult): void {
    if (this.mode === 'silent') return;
    this.lastEventAt = Date.now();
    const clean = truncate(result.text.replace(/\s+/g, ' ').trim(), 200);

    // ESTA delegação terminou: o subagente entrega e o bloco dele fecha. Buscar
    // pelo id do próprio `Task` é o que faz o fechamento funcionar com vários em
    // paralelo — cada resultado encontra o seu, em qualquer ordem que chegue.
    const encerrada = this.delegations.get(result.id);
    if (encerrada) {
      const { agentId, blockId } = encerrada;
      this.delegations.delete(result.id);
      this.log(blockId, result.isError ? 'error' : 'ok', clean || 'entregue');
      this.patchBlock(blockId, { state: result.isError ? 'error' : 'done', progress: 100 });
      this.setAgentState(agentId, result.isError ? 'error' : 'done', 100, null);
      this.reigning.delete(agentId);
      // Entregou: a skill dele APAGA agora, não na próxima ferramenta que
      // alguém usar. Sem isto ela ficava acesa depois do agente ter ido embora,
      // e o painel mostrava trabalho que não estava mais acontecendo.
      this.setSkillsInUse(this.litSkills(null));
      this.clearLinksOf(agentId);
      // O principal só volta a trabalhar quando o ÚLTIMO subagente entrega:
      // enquanto sobrar um, ele continua esperando, e é isso que "blocked" diz.
      if (this.delegations.size === 0) {
        this.setAgentState('claude', 'working', this.guessProgress());
      }
      this.showWaiting();
      if (result.isError) this.hooks.onError?.(clean);
      return;
    }

    if (!result.isError) return;
    const owner = result.parentToolUseId ? this.delegations.get(result.parentToolUseId) : undefined;
    const block = this.blockFor(owner?.agentId ?? 'claude');
    this.log(block.id, 'error', clean);
    this.hooks.onError?.(clean);
  }

  private onResult(result: TurnResult): void {
    // O consumo conta mesmo em turno silencioso: gastou, gastou.
    this.usage = {
      ...this.usage,
      tokensUsed: this.usage.tokensUsed + result.inputTokens + result.outputTokens,
      costUsd: Number((this.usage.costUsd + result.costUsd).toFixed(4)),
      updatedAt: Date.now(),
    };
    this.emit({ type: 'usage', usage: this.usage });
    // Turno interno não mexe na tela; conversa que não investigou nada também
    // não tem o que encerrar.
    if (this.mode === 'silent') return;
    if (this.mode === 'investigation' && !this.workflow) return;
    this.finish(result.isError ? 'failed' : 'done');
  }

  private onRateLimit(limit: RateLimit): void {
    this.usage = {
      ...this.usage,
      windowPct: Math.round(limit.utilization * 100),
      windowResetsAt: limit.resetsAt,
      contextPct: Math.round(limit.utilization * 100),
      updatedAt: Date.now(),
    };
    this.emit({ type: 'usage', usage: this.usage });
  }

  private finish(state: 'done' | 'failed' | 'cancelled', summary?: string): void {
    this.delegations.clear();
    this.reigning.clear();
    this.currentAction = '';
    this.currentSkill = '';
    this.clearLinks();
    this.skills.forEach((skill) => {
      if (skill.inUse) {
        skill.inUse = false;
        this.emit({ type: 'skill.state', skillId: skill.id, inUse: false });
      }
    });
    this.agents.forEach((agent) => this.setAgentState(agent.id, 'idle', 0, null));
    // Concluído e interrompido são coisas diferentes, e o bloco tem de dizer
    // qual foi: marcar tudo como "done" depois de um abortar apresentava
    // trabalho pela metade como trabalho entregue.
    const fecho: Block['state'] = state === 'cancelled' ? 'cancelled' : 'done';
    this.blocks.forEach((block) => {
      if (block.state === 'running') {
        this.patchBlock(block.id, { state: fecho, progress: state === 'cancelled' ? block.progress : 100 });
      }
    });
    if (!this.workflow) return;
    /*
     * O workflow encerrado SAI do ar aqui dentro.
     *
     * Ficava pendurado com estado "done", e o efeito era pior do que parece: o
     * turno seguinte via `this.workflow` preenchido, não abria um novo — e
     * `openWorkflow`, que é quem limpa os blocos, nunca rodava. Resultado: a
     * tela continuava mostrando o workflow ANTERIOR, com o cabeçalho cravado em
     * "✓ CONCLUÍDO" e os blocos velhos parados, enquanto o agente trabalhava
     * sem aparecer em lugar nenhum. Daí a sensação de que a sessão tinha
     * morrido e só voltava se você pedisse de novo.
     *
     * A tela guarda a própria cópia e continua mostrando o resultado; o que
     * zeramos é a nossa, para o próximo turno nascer limpo.
     */
    const encerrado = { ...this.workflow, state, progress: 100 };
    this.workflow = null;
    const investigacao = encerrado.kind === 'investigation';
    this.emit({ type: 'workflow.finished', id: encerrado.id, state, summary });
    this.currentAction = '';
    this.currentSkill = '';
    // Quem lê o resumo em voz alta é a execução. A investigação já responde
    // pelo Talking — narrar de novo seria o agente falando duas vezes.
    if (!investigacao) this.hooks.onFinish?.(state, this.lastText);
  }

  /**
   * Por quem o agente principal está esperando, agora.
   *
   * Dizer "Aguardando Dev Qa" quando há quatro rodando não é impreciso, é
   * errado: some com três e faz parecer que o trabalho encolheu. Com um só,
   * continua sendo o nome dele — que é a informação útil quando é um só.
   */
  private showWaiting(): void {
    const abertas = [...this.delegations.values()];
    if (abertas.length === 0) return;
    const principal = this.blockFor('claude');
    const nomes = abertas.map(
      (item) => this.agents.find((agent) => agent.id === item.agentId)?.name ?? 'subagente',
    );
    const action = nomes.length === 1
      ? `Aguardando ${nomes[0]}`
      : `Aguardando ${nomes.length} especialistas: ${truncate(nomes.join(', '), 54)}`;
    this.patchBlock(principal.id, { action, state: 'running' });
  }

  /**
   * Quais cartões do painel Skill devem estar acesos neste instante.
   *
   * A skill corrente de CADA agente que ainda tem bloco aberto, mais o grupo de
   * ferramenta da chamada de agora. Acender só a da última chamada era dizer
   * que os outros três especialistas pararam de trabalhar — eles não pararam,
   * só não foram os últimos a aparecer no stream.
   */
  private litSkills(current: string | null): string[] {
    const ativos = new Set(
      [...this.blocks.values()].filter((block) => block.state === 'running').map((block) => block.agentId),
    );
    const acesas = new Set<string>();
    if (current) acesas.add(current);
    this.reigning.forEach((skillId, agentId) => {
      if (ativos.has(agentId)) acesas.add(skillId);
    });
    return [...acesas];
  }

  /* ------------------------------------------------------------ auxiliares -- */

  /** Sem saber quantos passos faltam, crescemos rápido no começo e desaceleramos. */
  private guessProgress(): number {
    return Math.min(95, Math.round(100 * (1 - Math.exp(-this.toolCount / 7))));
  }

  private blockFor(agentId: string): Block {
    const existing = [...this.blocks.values()].find((block) => block.agentId === agentId);
    if (existing) return existing;
    const block: Block = {
      id: `blk_${agentId}_${Date.now().toString(36)}`,
      agentId,
      index: this.blocks.size,
      action: '',
      skillId: null,
      state: 'running',
      progress: 0,
      logs: [],
      artifacts: [],
    };
    this.blocks.set(block.id, block);
    this.emit({ type: 'block.upsert', block });
    return block;
  }

  private patchBlock(id: string, patch: Partial<Block>): void {
    const block = this.blocks.get(id);
    if (!block) return;
    Object.assign(block, patch);
    this.emit({ type: 'block.patch', patch: { id, ...patch } });
  }

  private log(blockId: string, level: LogEntry['level'], text: string): void {
    if (!text) return;
    const entry: LogEntry = { ts: Date.now(), level, text };
    this.blocks.get(blockId)?.logs.push(entry);
    this.emit({ type: 'block.log', blockId, entry });
  }

  private setAgentState(id: string, state: Agent['state'], progress: number, skillId?: string | null): void {
    const agent = this.agents.find((item) => item.id === id);
    if (!agent) return;
    agent.state = state;
    agent.progress = progress;
    if (skillId !== undefined) agent.skillId = skillId;
    this.emit({ type: 'agent.state', agentId: id, state, progress, skillId });
  }

  /**
   * Acende exatamente estas skills e apaga o resto.
   *
   * São várias porque coexistem: a skill que rege a delegação segue acesa
   * enquanto o subagente lê arquivo, e a leitura acende junto.
   */
  private setSkillsInUse(ids: string[]): void {
    const acesas = new Set(ids);
    this.skills.forEach((skill) => {
      const next = acesas.has(skill.id);
      if (skill.inUse !== next) {
        skill.inUse = next;
        this.emit({ type: 'skill.state', skillId: skill.id, inUse: next });
      }
    });
  }

  /**
   * Delegou para quem?
   *
   * Se o agente já está no catálogo (veio de um plugin ou do `.claude`), quem
   * acende é o cartão dele — nada de criar um segundo cartão com o mesmo nome.
   * Só o que não conhecemos vira subagente novo na tela.
   */
  private agentForDelegation(kind: string): string {
    return this.installedAgents.get(bareName(kind)) ?? this.ensureSubAgent(kind).id;
  }

  private ensureSubAgent(kind: string): Agent {
    const id = `sub:${kind}`;
    const existing = this.agents.find((agent) => agent.id === id);
    if (existing) return existing;
    const agent = subAgent(kind, this.agents.length - 1);
    this.agents.push(agent);
    this.emit({ type: 'agents.sync', agents: this.agents });
    return agent;
  }

  /**
   * Acende as setas DESTE agente, sem apagar as dos outros.
   *
   * Com três agentes em paralelo, apagar tudo a cada ferramenta deixava só o
   * último com seta — e a tela mentia sobre quem estava trabalhando. Os ids são
   * fixos por agente, então reativar apenas atualiza a seta dele.
   *
   * A cor é a do agente, nas duas pontas: é assim que se distingue de quem é
   * cada linha quando várias cruzam a tela ao mesmo tempo.
   */
  private focusLinks(agentId: string, blockId: string, skillId: string | null, tool: string): void {
    const color = this.agents.find((agent) => agent.id === agentId)?.color;
    const toBlock = `lk_${agentId}_block`;
    const toSkill = `lk_${agentId}_skill`;

    this.emit({ type: 'link.activated', link: {
      id: toBlock, from: { kind: 'agent', id: agentId }, to: { kind: 'block', id: blockId },
      label: 'executa', color,
    }});
    this.activeLinks = [...new Set([...this.activeLinks, toBlock])];

    // Delegar não acende cartão de skill nenhum — e a seta de skill que estava
    // acesa antes precisa APAGAR, senão ela fica apontando para a última coisa
    // que ele fez, como se ainda estivesse fazendo.
    if (!skillId) {
      this.emit({ type: 'link.deactivated', linkId: toSkill });
      this.activeLinks = this.activeLinks.filter((id) => id !== toSkill);
      return;
    }

    this.emit({ type: 'link.activated', link: {
      id: toSkill, from: { kind: 'agent', id: agentId }, to: { kind: 'skill', id: skillId },
      label: tool.toLowerCase(), color,
    }});
    this.activeLinks = [...new Set([...this.activeLinks, toSkill])];
  }

  /** Apaga as setas de um agente só — quando ele termina a parte dele. */
  private clearLinksOf(agentId: string): void {
    const meus = this.activeLinks.filter((id) => id.startsWith(`lk_${agentId}_`));
    meus.forEach((id) => this.emit({ type: 'link.deactivated', linkId: id }));
    this.activeLinks = this.activeLinks.filter((id) => !meus.includes(id));
  }
  private clearLinks(): void {
    this.activeLinks.forEach((id) => this.emit({ type: 'link.deactivated', linkId: id }));
    this.activeLinks = [];
  }
}

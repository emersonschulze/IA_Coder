import { randomUUID } from 'node:crypto';
import type { ClaudeSession, RateLimit, ToolUse, TurnResult } from './claude.js';
import {
  MAIN_AGENT, SKILLS, artifactFromTool, bareName, describeTool, installedAgent, installedSkill,
  skillForTool, subAgent, truncate,
} from './catalog.js';
import type { DiscoveredCatalog } from './discovery.js';
import type {
  Agent, Artifact, Block, LogEntry, ServerEvent, Skill, Usage, Workflow,
} from './protocol.js';
import type { AccountUsage } from './usage.js';

type Emit = (event: ServerEvent) => void;

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
  /** Turnos internos (extrair assunto para o Tree) não devem virar bloco na tela. */
  muted = false;

  /** Nome chamado pelo Claude → id do cartão na tela. */
  private installedAgents = new Map<string, string>();
  private installedSkills = new Map<string, string>();

  /** Último texto que o agente escreveu — vira o resumo falado no fim. */
  private lastText = '';
  /** O que está sendo feito agora — texto técnico, para o log do bloco. */
  currentAction = '';
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

    const discovered = catalog.agents.map(installedAgent);
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

    this.emit({ type: 'agents.sync', agents: this.agents });
    this.emit({ type: 'skills.sync', skills: this.skills });
  }

  syncCatalog(): void {
    this.emit({ type: 'agents.sync', agents: this.agents });
    this.emit({ type: 'skills.sync', skills: this.skills });
    this.emit({ type: 'archives.sync', archives: this.artifacts });
    this.emit({ type: 'usage', usage: this.usage });
    if (this.workflow) {
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

    this.clearLinks();
    this.blocks.clear();
    this.toolCount = 0;
    this.workflow = {
      id: `wf_${Date.now().toString(36)}`,
      title,
      state: 'running',
      step: 0,
      totalSteps: 0,
      progress: 0,
      startedAt: Date.now(),
    };
    this.emit({ type: 'workflow.started', workflow: this.workflow });
    this.setAgentState('claude', 'working', 0);
    this.blockFor('claude');
    return true;
  }

  cancel(): void {
    if (!this.workflow) return;
    this.claude.stop();
    this.finish('cancelled', 'Execução abortada.');
  }

  /* --------------------------------------------------------------- ligação -- */

  private wire(): void {
    this.claude.on('text', (text: string) => this.onText(text));
    this.claude.on('tool', (tool: ToolUse) => this.onTool(tool));
    this.claude.on('tool_result', (result: { id: string; isError: boolean; text: string }) =>
      this.onToolResult(result));
    this.claude.on('result', (result: TurnResult) => this.onResult(result));
    this.claude.on('rate_limit', (limit: RateLimit) => this.onRateLimit(limit));
  }

  private onText(text: string): void {
    if (this.muted) return;
    const blockId = this.blockFor('claude').id;
    const clean = text.replace(/\s+/g, ' ').trim();
    this.lastText = clean;
    this.log(blockId, 'info', truncate(clean, 300));
    // Só o texto escrito. Quem decide o que é falado é a narração, no index —
    // ter dois narradores foi o que fazia a voz atropelar a si mesma.
    this.emit({ type: 'assistant.say', text: truncate(text, 400), speak: false });
  }

  private onTool(tool: ToolUse): void {
    if (this.muted) return;
    const isDelegation = tool.name === 'Task';
    const agentId = isDelegation
      ? this.agentForDelegation(String(tool.input.subagent_type ?? 'agente'))
      : 'claude';

    // A skill de verdade, quando ele invoca uma, é mais informativa do que o
    // grupo de ferramentas — é ela que ganha a seta e o brilho.
    const invoked = tool.name === 'Skill'
      ? this.installedSkills.get(bareName(String(tool.input.skill ?? tool.input.name ?? '')))
      : undefined;
    const skillId = invoked ?? skillForTool(tool.name);
    const block = this.blockFor(agentId);
    const action = describeTool(tool.name, tool.input);

    this.toolCount += 1;
    this.setAgentState(agentId, 'working', this.guessProgress());
    this.setSkillInUse(skillId);
    this.currentAction = action;
    this.currentSkill = skillForTool(tool.name);
    this.patchBlock(block.id, { action, skillId, state: 'running', progress: this.guessProgress() });
    this.log(block.id, 'info', action);
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

  private onToolResult(result: { id: string; isError: boolean; text: string }): void {
    if (this.muted || !result.isError) return;
    const block = this.blockFor('claude');
    const clean = truncate(result.text.replace(/\s+/g, ' ').trim(), 200);
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
    if (this.muted) return;
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
    this.clearLinks();
    this.skills.forEach((skill) => {
      if (skill.inUse) {
        skill.inUse = false;
        this.emit({ type: 'skill.state', skillId: skill.id, inUse: false });
      }
    });
    this.agents.forEach((agent) => this.setAgentState(agent.id, 'idle', 0, null));
    this.blocks.forEach((block) => {
      if (block.state === 'running') this.patchBlock(block.id, { state: 'done', progress: 100 });
    });
    if (!this.workflow) return;
    this.workflow = { ...this.workflow, state, progress: 100 };
    this.emit({ type: 'workflow.finished', id: this.workflow.id, state, summary });
    this.currentAction = '';
    this.currentSkill = '';
    this.hooks.onFinish?.(state, this.lastText);
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

  private setSkillInUse(skillId: string): void {
    this.skills.forEach((skill) => {
      const next = skill.id === skillId;
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

  /** Apaga as setas anteriores e acende as do momento. */
  private focusLinks(agentId: string, blockId: string, skillId: string, tool: string): void {
    this.clearLinks();
    const toBlock = `lk_${agentId}_block`;
    const toSkill = `lk_${agentId}_skill`;
    this.emit({ type: 'link.activated', link: {
      id: toBlock, from: { kind: 'agent', id: agentId }, to: { kind: 'block', id: blockId }, label: 'executa',
    }});
    this.emit({ type: 'link.activated', link: {
      id: toSkill, from: { kind: 'agent', id: agentId }, to: { kind: 'skill', id: skillId }, label: tool.toLowerCase(),
    }});
    this.activeLinks = [toBlock, toSkill];
  }

  private clearLinks(): void {
    this.activeLinks.forEach((id) => this.emit({ type: 'link.deactivated', linkId: id }));
    this.activeLinks = [];
  }
}

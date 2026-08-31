# Protocolo IA_Coder (WebSocket)

Transporte: WebSocket em `ws://localhost:8787/ws`. Payload: JSON UTF-8, um evento por frame.
Todo evento tem um campo `type`. Fonte da verdade dos tipos: `apps/web/src/types/protocol.ts`.

## Cliente → Servidor (`ClientCommand`)

| type | payload | efeito |
|---|---|---|
| `conversation.input` | `{ text, images? }` | **o jeito único de pedir algo.** Fala com o Talking; se virar um plano e o usuário confirmar, é isso que dispara o workflow. `images` é opcional, uma lista de `{ mediaType, data, name? }` em base64. |
| `conversation.confirm` | `{ accept }` | aceita ou recusa o plano pendente (`pending`) |
| `conversation.start` / `conversation.stop` | `{}` | liga/desliga só o microfone (mão-livre). Não afeta o texto digitado, nem apaga histórico ou plano pendente. |
| `prompt.submit` | `{ text, source: 'text' \| 'voice' }` | **legado.** O servidor ainda aceita, mas a UI não manda mais — todo pedido passa por `conversation.input`. |
| `workflow.cancel` | `{ id }` | aborta o workflow e todos os agentes |
| `agent.inspect` | `{ agentId }` | pede ao servidor as ligações atuais do agente (hover) |
| `project.browse` | `{ path? }` | lista as subpastas de um caminho (para o seletor) |
| `project.roots` | `{}` | lista as unidades de disco (C:, D:, G:…) |
| `project.set` | `{ path }` | troca a pasta do projeto, salva nas preferências e reabre os processos |
| `project.pick` | `{}` | abre o seletor de pastas do Windows e já troca o projeto |
| `runtime.restart` | `{ target: 'shell' \| 'claude' \| 'both' }` | reabre os processos na pasta atual |
| `tree.list` | `{}` | pede o nível 1 do Tree (assuntos) |
| `tree.open` | `{ subjectId }` | pede o nível 2 (stack daquele assunto) |
| `knowledge.save` | `{}` | grava a análise atual como assunto reutilizável |
| `knowledge.forget` | `{ subjectId }` | apaga um assunto |
| `ping` | `{}` | keepalive; servidor responde `pong` |

## Servidor → Cliente (`ServerEvent`)

### Sessão e catálogo
- `session.hello` — `{ session }` identidade da sessão, plano e limites.
- `agents.sync` — `{ agents }` **catálogo completo**. Sempre mandar todos, inclusive os ociosos.
- `skills.sync` — `{ skills }` idem para skills.

O catálogo é lido do disco pelo servidor (`apps/server/src/discovery.ts`), não escrito à
mão: plugins instalados (`~/.claude/plugins/installed_plugins.json`), o `.claude` do
projeto e o `.claude` pessoal. Cada agente e cada skill de lá traz `source` — o nome do
plugin, `projeto` ou `pessoal`.

`skills.sync` mistura duas naturezas, separadas por `kind`:

| `kind` | o que é | exemplo |
|---|---|---|
| `tool` | grupo de ferramenta do próprio Claude Code; é o que acende a cada passo | `read`, `edit`, `shell` |
| `skill` | skill instalada de verdade, achada em disco | `auditar-cnpj`, `figma-use` |

Como plugin de escopo `project` só vale na pasta onde foi instalado, **o catálogo muda
quando o projeto muda** — o servidor revarre e reemite os dois eventos a cada troca.

> Regra de UI: fora de execução a tela exibe **todos** os agentes e skills em brilho pleno.
> O escurecimento só acontece enquanto há agente com `state: 'working'`.

### Workflow
- `workflow.started` — `{ workflow }`
- `workflow.updated` — `{ patch }` patch parcial (`progress`, `step`, `etaSeconds`, `state`)
- `workflow.finished` — `{ id, state, summary? }`

### Blocos (um por agente participante)
- `block.upsert` — `{ block }` cria/substitui o bloco
- `block.patch` — `{ patch }` `action`, `skillId`, `state`, `progress`
- `block.log` — `{ blockId, entry }` linha de log com `ts` e `level`
- `block.artifact` — `{ blockId, artifact }` arquivo gerado

### Setas (o que está ligado a quê, agora)
- `link.activated` — `{ link }` `from` e `to` são `Ref = { kind, id }`
- `link.deactivated` — `{ linkId }`

O servidor é dono das setas. Ao trocar de etapa: desative as antigas e ative as novas —
o `WireLayer` faz fade-out/fade-in sozinho.

### Projeto e processos
- `project.state` — `{ project }` caminho, nome, recentes e o estado do PowerShell
  e do Claude (`stopped` · `starting` · `ready` · `thinking` · `error`).
- `project.listing` — `{ listing }` resposta de `project.browse` / `project.roots`.

Quem lista o disco é o servidor: o navegador não entrega caminho real de pasta.

### Tree — memória reutilizável
- `tree.subjects` — `{ graph, enabled }` **nível 1**: os assuntos já confirmados e
  como se relacionam. `enabled: false` quando o Postgres não está de pé.
- `tree.detail` — `{ detail }` **nível 2**: os micro frontends, serviços, bancos e
  caches daquele assunto, e como se ligam.
- `knowledge.saved` — `{ id, title }` confirmação de que o assunto entrou.

O Tree existe para **economizar token**. Quando alguém confirma que uma análise
ficou boa, ela vira um assunto com resumo e stack. Quando o plano pendente é
confirmado (`conversation.confirm` com `accept: true`) e o workflow vai começar,
o servidor procura assuntos parecidos (embedding se o Ollama estiver de pé; senão
semelhança de texto) e injeta os resumos como contexto antes do pedido — o agente
começa sabendo, em vez de investigar tudo de novo. Cada reaproveitamento
incrementa `hits`, que aparece no tamanho e na cor do nó.

### Talking (conversa — texto, voz e imagem, tudo pela mesma caixa)
- `conversation.state` — `{ active, thinking, pending }` onde a conversa está e qual
  plano espera aprovação. `active` é só o microfone (mão-livre); digitar funciona
  independente disso.
- `conversation.turn` — `{ role, text, images? }` cada fala, sua e dele, para a
  transcrição. `images` são as imagens anexadas naquela fala (mesmo formato de
  `conversation.input`), usadas para desenhar as miniaturas na bolha.
- `conversation.say` — `{ text }` **o que deve ser falado em voz alta**.
- `voice.health` — `{ stt, tts, wakeWord }` quais serviços locais estão de pé.

Duas regras que valem mais que o resto:

1. **Só `conversation.say` é falado.** O `assistant.say` é texto escrito, para a
   tela. Ter dois caminhos de voz fazia o agente se ouvir pelo microfone aberto e
   responder a si mesmo, num laço.
2. **Nada é executado durante a conversa.** O agente lê e investiga à vontade, mas
   editar arquivo só depois do seu "pode ir" — que vira um `workflow.started`
   comum, com blocos e setas.

Durante a execução ele narra: avisa ao começar, dá sinal de vida a cada 45s
dizendo o que está fazendo, fala uma vez se der erro, e lê o resumo no fim. O
consolidado da execução (resumo + arquivos gerados) chega para o painel Talking
pelo `result` guardado no estado do cliente — não existe mais um painel Result
separado; ele aparece encostado na última fala do agente, na própria
transcrição.

### Áudio (HTTP, fora do WebSocket)
| rota | entra | sai |
|---|---|---|
| `POST /voice/stt` | bytes de áudio | `{ text, wake, command }` — transcrição pelo Whisper local |
| `POST /voice/tts` | `{ text }` | WAV em pt-BR, pelo Piper local |

### Painéis auxiliares
- `usage` — `{ usage }` consumo **da conta**, não da sessão: `windowPct`/`windowResetsAt`
  (janela de 5 horas) e `weekPct`/`weekResetsAt` (limite semanal), puxados da API de
  conta da Anthropic (`/api/oauth/usage`, com o token OAuth do Claude Code) a cada
  60s, com backoff se a chamada falhar. `tokensUsed`/`tokensLimit`/`contextPct`/`costUsd`
  continuam vindo do próprio Claude Code, por sessão.
- `tree.sync` — `{ tree }` grafo de contexto (nós + arestas)
- `archives.sync` / `archive.added` — artefatos gerados
- `assistant.say` — `{ text, speak }` resposta em linguagem natural; `speak: true` dispara TTS
- `error` — `{ message }`

## Exemplo de troca

```jsonc
// → usuário digita ou fala no Talking
{ "type": "conversation.input", "text": "crie o CRUD de clientes em C# e a tela em React" }

// ← o agente conversa, propõe um plano...
{ "type": "conversation.turn", "role": "user", "text": "crie o CRUD de clientes em C# e a tela em React" }
{ "type": "conversation.turn", "role": "agent", "text": "Beleza, vou fazer o CRUD de clientes: API em C# e a tela em React. Posso ir?" }
{ "type": "conversation.state", "state": { "active": false, "thinking": false, "pending": { "title": "crie o CRUD…", "steps": ["..."], "risk": "low" } } }

// → usuário confirma
{ "type": "conversation.confirm", "accept": true }

// ← e só então vira workflow
{ "type": "workflow.started", "workflow": { "id": "wf_01", "title": "crie o CRUD…", "state": "running", "step": 0, "totalSteps": 4 } }
{ "type": "block.upsert", "block": { "id": "blk_01", "agentId": "be1", "index": 0, "state": "queued" } }
{ "type": "agent.state", "agentId": "be1", "state": "working", "skillId": "csharp", "progress": 0 }
{ "type": "link.activated", "link": { "id": "lk_1", "from": { "kind": "agent", "id": "be1" }, "to": { "kind": "block", "id": "blk_01" }, "label": "executa" } }
{ "type": "link.activated", "link": { "id": "lk_2", "from": { "kind": "agent", "id": "be1" }, "to": { "kind": "skill", "id": "csharp" }, "label": "usa C#" } }
{ "type": "block.log", "blockId": "blk_01", "entry": { "ts": 1756500000000, "level": "info", "text": "scaffold Domain/Entities/Cliente.cs" } }
```

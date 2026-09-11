# Protocolo IA_Coder (WebSocket)

Transporte: WebSocket em `ws://localhost:8787/ws`. Payload: JSON UTF-8, um evento por frame.
Todo evento tem um campo `type`. Fonte da verdade dos tipos: `apps/web/src/types/protocol.ts`.

## Cliente → Servidor (`ClientCommand`)

> A lista abaixo tem de bater **linha a linha** com a união `ClientCommand` de
> `apps/server/src/protocol.ts` — é ela que o `handle()` aceita de fato. Revisar o
> contrato (endurecer o socket, escrever outro cliente, montar uma allowlist) é
> comparar as duas listas, nunca só ler esta tabela: já aconteceu de `artifact.open`
> — que roda arquivo na máquina — ficar de fora daqui e passar batido numa revisão.

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
| `artifact.open` | `{ path, reveal? }` | **efeito local:** manda o Windows abrir o arquivo (`start`) ou selecioná-lo no Explorer (`reveal: true`). Só aceita caminho dentro da pasta de artefatos ou do projeto, e recusa executável quando não é `reveal` (`apps/server/src/picker.ts`) |
| `tree.list` | `{}` | pede o nível 1 do Tree (assuntos) |
| `tree.open` | `{ subjectId }` | pede o nível 2 (stack daquele assunto) |
| `knowledge.save` | `{}` | grava a análise atual como assunto reutilizável |
| `knowledge.forget` | `{ subjectId }` | apaga um assunto |
| `knowledge.discard` | `{}` | descarta a análise atual sem gravar; só some o convite de guardar (nada foi ao banco) |
| `knowledge.manual` | `{ title, summary, tags? }` | grava um assunto escrito por você, sem passar pelo agente — funciona com o Claude fora do ar |
| `auth.check` | `{}` | reconfere a credencial do Claude (`claude auth`) e reemite `auth.state` |
| `auth.login` | `{ mode?: 'shell' \| 'window' }` | **efeito local:** dispara `claude auth login --claudeai`. `shell` (padrão) usa o PowerShell já aberto e transmite a saída em `auth.login.line`; `window` abre um terminal visível. Ao dar certo, reabre o processo do Claude |
| `mcp.check` | `{}` | revarre os servidores MCP (`claude mcp list`) |
| `mcp.login` | `{ server, mode?: 'shell' \| 'window' }` | roda `claude mcp login "<server>"`. `shell` (padrão) usa o PowerShell que já está aberto e transmite a saída; `window` abre um terminal visível |
| `mcp.dismiss` | `{}` | você fechou o aviso de servidor bloqueado; limpa `blocked` |
| `settings.get` | `{}` | pede o estado atual de banco/Redis/voz (tela de Configurações) |
| `settings.save` | `{ patch: SettingsPatch }` | grava e aplica `database` / `redis` / `voice` sem reiniciar o servidor: mandar `database` reconecta o pool na hora (`closeDb` + `initDb`); mandar `voice` já vale na próxima fala/transcrição |
| `voice.list` | `{}` | pede o catálogo de vozes do Piper (instaladas e disponíveis para baixar) |
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
| `tool` | grupo de ferramenta do próprio Claude Code — o **como** | `read`, `edit`, `shell`, `mcp` |
| `skill` | habilidade de verdade — o **quê** | `auditar-cnpj`, `figma-use` |

Como plugin de escopo `project` só vale na pasta onde foi instalado, **o catálogo muda
quando o projeto muda** — o servidor revarre e reemite os dois eventos a cada troca.

`skills.sync` também é **reemitido durante a execução** quando uma skill é invocada sem
estar no disco varrido (as embutidas no Claude Code, um plugin instalado depois do boot).
Ela entra na lista com `source: "invocada"`. A alternativa era acender "Outras" com o
nome da skill na mão, que é a tela sabendo e não contando.

> **Qual skill acende.** Não é a da ferramenta desta chamada: é a que está **regendo**
> aquele agente. Uma skill começa a reger quando ele a invoca (`Skill`), quando é nomeada
> no prompt da delegação, ou quando ele abre o `SKILL.md` dela — e continua regendo
> enquanto ele lê, escreve e roda comando para cumpri-la. O grupo de ferramenta só acende
> quando não há skill nenhuma regendo, porque aí ele é a melhor resposta disponível para
> "o que está sendo feito". Cair para `shell` no primeiro comando seria trocar o QUÊ pelo
> COMO — era o que fazia a tela inteira parecer um terminal.

> **Identidade do subagente.** Um tipo de agente nomeado (`dev-system`) é sempre o mesmo
> cartão. Os tipos genéricos do Claude Code (`general-purpose`, `Explore`, `fork`…) ganham
> **um cartão por delegação**, com id `sub:<tipo>#<toolUseId>` e batizado pela tarefa que
> receberam — quatro `general-purpose` disparados na mesma leva são quatro trabalhadores,
> não um. Esses cartões são de uso único e somem no começo do workflow seguinte.

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
- `conversation.state` — `{ active, thinking, executing, pending }` onde a conversa
  está e qual plano espera aprovação. `active` é só o microfone (mão-livre); digitar
  funciona independente disso. `thinking` é o turno de conversa; `executing` é uma
  execução aprovada em curso — enquanto ela roda, a conversa não é atendida (uma
  pergunta no meio sequestraria o turno da execução) e a caixa de texto avisa.
- `conversation.turn` — `{ role, text, images? }` cada fala, sua e dele, para a
  transcrição. `images` são as imagens anexadas naquela fala (mesmo formato de
  `conversation.input`), usadas para desenhar as miniaturas na bolha.
- `conversation.say` — `{ text }` **o que deve ser falado em voz alta**.
- `voice.health` — `{ stt, tts, wakeWord }` quais serviços locais estão de pé.

`turn` e `say` carregam textos DIFERENTES quando o agente responde em prosa: o
`turn` vai inteiro (é o que fica escrito e legível) e o `say` é a versão curta,
sem marcação e cortada numa fronteira de frase (é o que a voz lê). Eram o mesmo
texto até a resposta escrita começar a aparecer picotada no meio da palavra — a
tela herdava um limite que só existia por causa do som.

### MCP (servidores conectados ao Claude Code)
- `mcp.state` — `{ servers, checkedAt, checking, reachable, permissionMode, blocked }`
  quem está configurado e se dá para usar.
- `mcp.login.line` — `{ server, line }` a saída do login, ao vivo.
- `mcp.login.done` — `{ server, ok, urls }` fim do login e os endereços de
  autorização que apareceram.

Duas coisas diferentes derrubam uma ferramenta de MCP, e o protocolo separa as
duas porque o conserto não é o mesmo:

1. **Sem credencial** — o servidor vem com `status: 'needs-auth'`. Resolve com
   `mcp.login`, que é OAuth e abre o navegador. Depois de aprovar, o servidor
   reabre o processo do Claude sozinho: sem isso a credencial nova só valeria na
   próxima vez que ele subisse.
2. **Sem permissão** — `reachable: false`. O processo roda em modo não
   interativo, e um `--permission-mode` como `acceptEdits` NÃO alcança ferramenta
   de MCP: o servidor aparece conectado, a ferramenta existe, e toda chamada
   volta `permission_denied`. Aqui login nenhum resolve — só o modo. Medido no
   CLI 2.1.251: nem `--allowedTools mcp__servidor`, nem o nome completo da
   ferramenta, nem `permissions.allow` no `--settings` mudam isso. Modos que
   alcançam: `auto` (padrão nosso) e `bypassPermissions`.

`blocked` conta que uma ferramenta acabou de ser barrada, com o motivo já
classificado — é o que faz o popup abrir sozinho no momento em que resolve
alguma coisa, em vez de a cada resposta.

### Configurações (banco, Redis, voz)
- `settings.state` — `{ settings: Settings, dbApplied?: boolean }` mandado assim
  que a aba conecta e de novo depois de todo `settings.save`. `settings.database`
  já vem com a senha mascarada — o servidor nunca devolve a senha em texto puro.
  `dbApplied` só aparece na resposta de um `settings.save` que mexeu em `database`:
  `true` quer dizer que o pool reconectou com a URL nova; `false`, que a conexão
  falhou e o servidor voltou para a anterior.
- `voice.options` — `{ voices: VoiceOption[] }` resposta de `voice.list`. Cada
  item tem `id`, `label` e `installed` (já baixada no volume do Piper ou não —
  a primeira síntese com uma voz nova baixa e fica em cache).

Nada disso reinicia o servidor. Trocar o banco fecha e reabre o pool do
Postgres na hora (`db.ts`: `closeDb()` + `initDb()`); trocar a voz ou a palavra
de despertar só muda o que `voice.ts` lê na próxima chamada — nenhum dos dois
mantém nada em cache de módulo. `workspace/settings.json` é o arquivo que
guarda isso entre uma execução e outra; ele pisa nos valores do `.env`, nunca
o contrário.

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
{ "type": "conversation.state", "state": { "active": false, "thinking": false, "executing": false, "pending": { "title": "crie o CRUD…", "steps": ["..."], "risk": "low" } } }

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

# Estado do projeto — retomada

> Escrito para você voltar depois de reiniciar a máquina (ou em outra sessão)
> sem precisar reconstruir contexto. Última atualização: 31/08/2026.

## Em uma frase

O IA_Coder está **funcionando de ponta a ponta**: você fala ou digita, o Claude
Code roda de verdade na pasta do seu projeto, a tela mostra os blocos e as setas
do que está acontecendo, e o que ficou bom vira conhecimento reutilizável no Tree.

---

## Como subir tudo

Três terminais, nesta ordem:

```powershell
# 1) infraestrutura
cd G:\IA_Coder
docker compose up -d                    # postgres + redis
docker compose --profile voice up -d    # opcional: whisper + piper (modo conversa)

# 2) servidor  (NÃO vai para container: precisa do PowerShell e dos seus repos)
cd G:\IA_Coder\apps\server
npm install
npm run dev                             # espere: [server] IA_Coder 0.3.0 em ws://127.0.0.1:8787/ws

# 3) interface
cd G:\IA_Coder\apps\web
npm install
npm run dev                             # http://localhost:5173  (Chrome ou Edge)
```

Endereços úteis: Postgres em `localhost:5433` (aponte o DBeaver ou outro
cliente para cá — sem Adminer, saiu do compose), Whisper em `:9000`, Piper em
`:5002`.

---

## O que está pronto e verificado

| Área | Situação |
|---|---|
| Interface completa (agents, skills, status, working, tree, archives) | ✅ testada |
| Setas animadas agente → bloco → skill | ✅ testada |
| Um `claude` persistente por projeto (mantém contexto entre pedidos) | ✅ testado |
| PowerShell escondido aberto na pasta do projeto | ✅ testado |
| Seletor de pasta pelo Explorer + preferências salvas | ✅ testado (fora o diálogo nativo, que só roda no Windows) |
| Tree de dois níveis: assunto → stack, com reaproveitamento | ✅ testado com Postgres real |
| Detecção de sessão expirada + login pelo PowerShell | ✅ testada a detecção; o OAuth em si só na sua máquina |
| Modo conversa: pergunta → plano → confirmação → execução → narração | ✅ testado com Claude real e simulado |
| Lupa (80% da tela) em Talking, Tree e Archives | ✅ testada |
| Talking: caixa única (texto + imagem anexada), histórico tipo chat | ⚠️ imagem anexada ainda não testada com o Claude real |

## O que ainda NÃO foi testado por ninguém

1. **Piper (a voz).** O Whisper já foi visto funcionando — transcreveu fala real
   na tela. O Piper nunca subiu. Teste:
   `docker compose --profile voice up -d` e depois ligar o modo conversa.
   A imagem do Piper é nossa (`docker/piper/`) — se falhar, o log dela dirá o quê.
2. **Qualidade da voz `pt_BR-faber-medium`.** Se soar ruim, troque `PIPER_VOICE`
   no `.env` (as vozes estão em `rhasspy/piper-voices` no HuggingFace).
3. **O diálogo nativo de pasta** (`claude auth login` e `FolderBrowserDialog`) —
   ambiente Linux não reproduz.
4. **Imagem anexada no Talking.** O código monta o bloco `{type:"image", source:
   {type:"base64", ...}}` no `stdin` do `claude` (mesmo formato da API da
   Anthropic) — nunca testado contra o CLI de verdade. Se ele recusar ou
   ignorar a imagem, o log do servidor mostra o que o Claude respondeu.

---

## Decisões que não são óbvias (não refaça sem ler)

**O servidor não vai para container.** Ele dá spawn no PowerShell e precisa
enxergar seus repositórios e credenciais. Container Linux não faz isso. Para o
Docker vai só infraestrutura.

**Um processo `claude` persistente, não um por pedido.** Usa
`--input-format stream-json`, então a conversa mantém contexto entre comandos e
os eventos chegam estruturados (dá para saber qual ferramenta ele usou e qual
arquivo tocou — é isso que alimenta os blocos).

**`claude auth status` mente.** Ele diz `loggedIn: true` porque existe uma
credencial guardada, não porque ela vale. Um 401 vindo da API é a única prova
real de expiração — por isso `markExpired()` não consulta o CLI.

**Só `conversation.say` é falado.** O `assistant.say` é texto escrito. Ter dois
caminhos de voz fazia o agente se ouvir pelo microfone aberto e responder a si
mesmo, em laço. Existe **um único narrador**: o `ConversationPanel`, que é quem
controla o microfone.

**Só existe um lugar para falar com o IA_Coder: o Talking.** (Superado pela
entrada mais abaixo, "Talking é o único jeito de pedir alguma coisa" — ficou
registrado aqui só para quem procurar pelo nome antigo "Caixa de Texto".)

**Existe um microfone só.** Voz é sempre o Talking — nunca existiu um segundo
consumidor do microfone na tela, e continua assim.

**O interruptor do modo conversa fica na barra de cima**, ao lado de VOZ ON —
é onde mora tudo que liga e desliga.

**Com o modo conversa ligado, o silêncio é o Enter.** 1,5s sem falar fecha a
gravação e envia. A palavra de ativação ("IA Coder", "Jarvis") virou opcional —
serve para chamá-lo pelo nome e é removida do começo da frase. Exigir a palavra
a cada fala fazia a mensagem sumir sem resposta quando o Whisper transcrevia o
nome de um jeito um pouco diferente. O tempo está em `SILENCE_MS`, em
`apps/web/src/hooks/useVoiceLoop.ts`.

**Nada é executado durante a conversa.** O agente lê e investiga à vontade, mas
editar arquivo só depois do seu "pode mandar" — que vira um workflow comum.

**O `DATABASE_URL` é derivado do compose.** O servidor monta o endereço a partir
de `POSTGRES_USER/PASSWORD/DB/PORT`. Uma fonte da verdade só.

**O banco reconecta sozinho a cada 10s.** Subir o Docker depois do servidor
funciona; o Tree acende sem reiniciar nada.

**O Status mostra o consumo REAL da conta, não desta sessão.** O `-p` do
Claude Code não expõe o `/usage`, e o `rate_limit_event` que o stream às vezes
manda nunca chegou a ser visto de verdade — por isso o painel ficava travado
em "0% há Xh". A solução: `apps/server/src/usage.ts` lê o token OAuth direto
de `%USERPROFILE%\.claude\.credentials.json` (o Claude Code guarda em texto
puro no Windows e no Linux; só no Mac ele migra para o Keychain) e chama
`https://api.anthropic.com/api/oauth/usage` — o mesmo endpoint que o `/usage`
do próprio Claude Code usa por trás. **Não é documentado oficialmente**, foi
descoberto pela comunidade (ferramentas de status line, menu bar) — pode
mudar ou devolver 429 sem aviso. Por isso qualquer falha vira `null` em vez de
zerar a tela: `index.ts` guarda o último número bom e só desiste de tentar de
novo (~10 pulsos, uns 10 min) depois de 3 falhas seguidas. Roda a cada minuto
junto do resto do pulso do Status, e uma vez no boot do servidor, para não
esperar o primeiro minuto para mostrar algo.

**Talking é o único jeito de pedir alguma coisa — o painel de Conversa virou
isto, e a Caixa de Texto original (com o botão Executar Workflow direto,
sem plano) foi embora de vez.** Antes existiam dois caminhos: um pedido
direto (`prompt.submit`, sem parar para perguntar nada) e a conversa
(`conversation.input`, que pergunta, propõe um plano e só executa depois do
"pode mandar"). Ficaram parecidos demais e confundiam qual caixa fazer o quê.
Agora só existe conversa: **toda mensagem, digitada ou falada, passa por
`conversation.input`**. Consequências:
- O reaproveitamento do Tree (assunto já confirmado vira contexto pronto, sem
  o agente investigar tudo de novo) — que antes só rodava em `prompt.submit`
  — mudou para dentro de `runPending()`, em `index.ts`, que é onde toda
  execução de verdade agora nasce.
- `conversation.start`/`conversation.stop` (o botão CONVERSA da barra de
  cima) **não resetam mais a conversa** — eles só ligam/desligam o
  microfone de mãos livres. Resetar apagaria um plano pendente ou o
  histórico só porque você quis digitar em vez de falar por um tempo.
- `prompt.submit` continua existindo no protocolo (o servidor ainda entende),
  mas nada na interface manda mais esse comando — é só compatibilidade.

**O Result sumiu como painel — virou parte do Talking.** O texto do resumo
já aparecia duas vezes (na Caixa de Texto E na Conversa, via narração), e os
únicos dados exclusivos do Result eram os links de arquivo e o botão
"Guardar no Tree". Agora eles aparecem encostados na última fala do agente,
dentro do próprio feed do Talking (`state.result` do store ainda existe, só
não tem mais painel próprio). `ResultPanel.tsx`/`.module.css` e
`PromptBox.tsx`/`.module.css` ficaram no disco sem uso — pode apagar quando
quiser.

**Uma caixa só, com o botão de enviar na frente — pedido explícito.** O
Talking tinha ganhado uma caixa separada para pedido direto (parecia
formulário) além do campo de chat. Virou uma pílula única: anexo (📎) +
texto + enviar (➤), sempre a mesma, sempre visível — Enter envia, Shift+Enter
quebra linha, Ctrl+Enter continua funcionando de qualquer lugar da tela.

**Adminer saiu do compose.** Quem já tem o DBeaver (ou outro cliente) não
precisa de mais um serviço web só para olhar tabela — aponte para
`localhost:5433` com o usuário/senha do `.env`. Se um dia precisar de volta,
o serviço está no histórico do git.

**Archives e Status viraram um painel só, com abas.** Ficavam em colunas
diferentes disputando altura; agora moram juntos (coluna da esquerda, no
lugar onde só o Status estava) e alternam sozinhos: Archives 3 minutos,
Status 20 segundos, repetindo — `DURATION` em
`apps/web/src/components/StatusArchivesPanel.tsx`. Clicar numa aba troca na
hora e reinicia a contagem dali; sem clique, ele sempre volta a alternar. O
`Panel.tsx` ganhou um modo `tabs` (props `tabs`/`activeTab`/`onTabChange`) só
para isso — quando não usado, o painel continua com título fixo como sempre.
Tirar o Archives da coluna da direita foi o que sobrou de espaço para a
**Conversa crescer**: o painel dela trocou de `flex: 0 0 auto` para
`flex: 1 1 auto`, e a transcrição (`.feed`) agora ocupa o que sobrar de
altura em vez de parar em 180px fixos — o scroll dela continua preso na
borda direita do painel, então não quebra em telas menores.

**Talking maior que o Tree, de propósito.** Pedido explícito: o Talking
devia crescer bem mais que o Tree na mesma coluna. Os dois usam
`flex-basis: 0` (em vez de `auto`) para a proporção não depender do
conteúdo de cada um — hoje é `flex: 2 1 0px` no Talking (`ConversationPanel.tsx`)
contra `flex: 1 1 0px` no Tree (`TreePanel.tsx`), com `minHeight` de 320 e 220
respectivamente como piso. Se pedir para inverter de novo, é só trocar esses
dois números.

**Repositório no GitHub, README reescrito e LICENSE MIT.** O código foi para
`github.com/emersonschulze/IA_Coder`. O `README.md` ganhou uma seção "Como
funciona" (Talking → plano → confirmação → workflow → Tree) e um GIF de
demonstração (`docs/demo.gif`), gravado com o `apps/web/tools/mock-server.mjs`
— que por sinal estava desatualizado (ainda respondia a `prompt.submit`) e foi
corrigido para falar `conversation.input`/`conversation.confirm`, o protocolo
atual do Talking. `LICENSE` é MIT, em nome de Émerson Schulze.

**Agents e Skill mostram o que está instalado de verdade, lido do disco.**
Antes o painel Agents tinha um cartão só (o "Claude Code") e o Skill tinha
sete — que não são skills, são os GRUPOS DE FERRAMENTA dele (leitura, edição,
shell…). Quem instalou um plugin com dezesseis agentes e sessenta e seis
skills não via nenhum deles. Agora `apps/server/src/discovery.ts` varre três
lugares — os plugins de `~/.claude/plugins/installed_plugins.json`, o
`.claude` do projeto e o `.claude` pessoal — e lê `agents/<nome>.md` ou
`agents/<nome>/AGENT.md` e `skills/<nome>/SKILL.md`. O catálogo é reemitido a
cada troca de projeto, porque plugin de escopo `project` só vale na pasta onde
foi instalado. Três detalhes que custaram tempo:
- Os arquivos são do Windows (CRLF). Sem normalizar o CR do fim da linha, o
  frontmatter não casa (o `.` do regex não pega terminador de linha) e **toda
  descrição some**.
- Nem todo agente tem frontmatter — há plugins cujos `AGENT.md` começam direto
  no `# Agente: x`. Nesse caso a primeira linha de prosa vira a descrição.
- Quando o Claude delega para um agente que já está no catálogo, quem acende é
  o cartão dele; só o desconhecido vira subagente novo (`agentForDelegation`,
  no orquestrador). Idem para a ferramenta `Skill`: ela acende a skill de
  verdade, não o grupo genérico.
As duas listas ficaram grandes, então os painéis ganharam um filtro de uma
linha (`PanelSearch`, em `Panel.tsx`) que aparece sozinho a partir de 8
agentes / 12 skills.

**O plano pendente mora DENTRO da conversa, não abaixo dela.** Ele era irmão
do feed no mesmo flex, com `flex: 0 0 auto`: um plano de seis passos não
cabia, empurrava a caixa de digitar para fora do painel e você ficava vendo
uma pergunta que não tinha como responder — sem rolagem, sem botão. Agora ele
é a última bolha do feed e rola junto com o resto; o efeito de auto-scroll
também reage a `conversation.pending`, então os botões sempre chegam à vista.
No mesmo caminho, o `.wrap` do Talking trocou `height: 100%` por
`flex: 1 1 auto` — com `height: 100%` ele media o painel INTEIRO, cabeçalho
incluso, e sobrava sempre a altura do cabeçalho para fora.

**Confirmar pelo botão também é falar.** Clicar em "Pode ir" mudava o estado
sem deixar rastro: o plano sumia e a conversa ficava com a pergunta dele e
nenhuma resposta sua. Agora o clique vira um turno seu ("Pode ir." / "Agora
não.") na tela e no histórico que o Claude enxerga (`Conversation.note`), e
recusar tem resposta falada em vez de silêncio. O ensaio
(`apps/web/tools/mock-server.mjs`) faz igual.

**O sinal de vida não recita comando.** Ele dizia "Ainda nisso. Agora: rodando
cd c:/repositorio && claude plugin list 2>&1 | head -30" — isso é log de
terminal, não conversa. Agora fala o TIPO de trabalho ("Ainda dando uma olhada
no projeto", "Continuo mexendo nos arquivos — te aviso assim que terminar"),
alternando a frase para não soar gravado. O texto técnico continua no log do
bloco, que é o lugar dele: `orchestrator.currentAction` alimenta o bloco e o
novo `currentSkill` alimenta a fala.

**`npm run build` do web voltou a passar — e o navegador continua sem tipos de
Node.** O `tsc -b` quebrava em `vite.config.ts` (`Cannot find module 'node:url'`,
`import.meta.url`, `process`): o arquivo é código de Node, mas o `apps/web` não
tinha `@types/node`. Instalado, com um cuidado: `types: ["node"]` só no
`tsconfig.node.json` (que compila apenas o `vite.config.ts`) e `types: []` no
`tsconfig.json` do app. Sem esse `types: []`, o `@types/node` entraria global no
código do navegador e `setTimeout` passaria a ter duas assinaturas — a do DOM
(devolve `number`) e a do Node (devolve `NodeJS.Timeout`). Não remova nenhum dos
dois achando que é sobra. O `npm run typecheck` sempre passou; era só o `build`.

**Ler é trabalho, e trabalho aparece no centro — não na conversa.** Um pedido de
análise no Talking ficava minutos em "pensando…" sem uma linha de log e terminava
em "o agente demorou demais para responder". Três causas empilhadas:
- Durante um turno de conversa o orquestrador ficava **mudo**, para o envelope
  JSON não virar bloco na tela. Só que isso silenciava também o uso de
  ferramenta: o agente lia dezenas de arquivos e o centro dizia "workflow vazio".
  O `muted` binário virou `mode: 'full' | 'investigation' | 'silent'`. Em
  conversa o modo é `investigation`: bloco, seta e skill acesa aparecem
  normalmente; só o TEXTO fica de fora. O workflow nasce **preguiçoso**, na
  primeira ferramenta usada — quem só conversa não merece um workflow vazio
  piscando no centro. O `Workflow` ganhou `kind`, o cabeçalho mostra
  "◈ INVESTIGANDO" em vez de "EXECUTANDO", e investigação não vira Result: a
  resposta dela já saiu pelo Talking, e herdar o texto anterior mostraria o
  resumo de uma execução velha como se fosse desta leitura.
- O `ask()` tinha limite de **duração total** (120s). Só que o próprio
  enquadramento da conversa autoriza o agente a ler e investigar antes de
  responder — analisar um repositório grande passa disso trabalhando. Virou
  limite de **ociosidade**: cada ferramenta usada e cada texto escrito zeram o
  relógio, e o prazo subiu para 4 minutos sem sinal de vida.
- O pior, invisível: ao estourar o limite, o turno continuava rodando no `claude`
  e o `once('result')` seguinte podia ser resolvido pela resposta ATRASADA — as
  respostas trocavam de lugar sem ninguém perceber. Agora a sessão marca `busy`
  até o resultado atrasado chegar, e um pedido novo nesse meio-tempo recebe
  "ainda estou terminando o pedido anterior" em vez de uma resposta errada.

**A delegação nunca aparecia porque a ferramenta mudou de nome.** Pedir "use o
agente orquestrador" acionava o orquestrador de verdade, mas na tela tudo ficava
creditado ao Claude Code e o cartão dele nunca acendia. Causa: a ferramenta de
delegação deste Claude Code chama-se **`Agent`**, e o código testava
`tool.name === 'Task'` (o nome antigo). O sintoma no log era uma linha crua
"Agent", sem descrição — o `describeTool` também só conhecia `Task`. Agora os
dois nomes valem (`DELEGATION_TOOLS`), e a delegação virou um estado de verdade
no orquestrador:
- O bloco do subagente é dele, e **tudo o que o stream traz durante a delegação
  vai para lá** — o principal está parado esperando, então o trabalho é do
  subagente. O principal fica em `blocked` com "Aguardando orquestrador".
- A skill invocada dentro da delegação (`mapear-codigo`) fica acesa enquanto ela
  durar, junto com o grupo de ferramenta do momento. Por isso `setSkillInUse`
  virou `setSkillsInUse`, com várias.
- O `tool_result` daquela delegação fecha o bloco. Sem isso o cartão ficava
  "executando" para sempre, mesmo com a tarefa entregue.
- Cada bloco em execução mostra um relógio correndo. É o que separa "demorado"
  de "travado" numa delegação de vários minutos.

**Catálogo grande mudou o que é um bom padrão.** Com sete skills escritas à mão,
lista estável era mais legível e "fixar ativos no topo" vinha desligado. Com 86
skills reais, o cartão em uso vive fora da vista — e a seta que aponta para ele
também. Agora vem ligado (`usePrefs`), e mais duas consequências:
- O FLIP não anima salto maior que 260px. Promover uma skill do fim de uma lista
  de 86 é um percurso de milhares de pixels: durante a animação o card fica fora
  do painel, que parece vazio, com a seta apontando para o nada.
- Só o primeiro card ativo de cada painel puxa a rolagem. Dois disputando
  deixavam o painel numa posição que não mostrava nenhum dos dois.

E "etapa 3/2" no cabeçalho era garantido: passo e total são o mesmo contador de
ferramentas, e ainda somava 1. Virou contagem — "5 passos" — que é o que o dado
realmente é.

**Três agentes em paralelo pedem três cores — e as setas precisam sobreviver.**
Com a delegação funcionando, virou comum ter principal + dois subagentes na tela
ao mesmo tempo, e aí apareceram três problemas:
- **`focusLinks` apagava as setas de todo mundo** a cada ferramenta e reacendia
  só as do agente da vez. Com três trabalhando, só o último tinha seta e a tela
  mentia sobre quem estava ativo. Agora cada agente tem seus ids fixos
  (`lk_<agente>_block` / `_skill`), reativar só atualiza os dele, e
  `clearLinksOf` apaga apenas os de quem terminou.
- **A cor da seta é a do agente**, nas duas pontas. E a cor do agente passou a
  ser distribuída por ÍNDICE, não por hash do nome: hash colide à toa — era o
  que fazia "arquiteto" nascer idêntico ao "Claude Code", os dois ciano. O ciano
  saiu da paleta dos instalados: ele é do agente principal.
- **A seta grampeia na borda do painel.** Um card rolado para fora continua
  tendo posição — muitas vezes a milhares de pixels fora da janela — e a seta o
  seguia até lá, atravessando a tela. O `rectOf` agora corta o retângulo pelos
  limites do `[data-anchor-clip]` (o corpo do painel): a seta encosta na borda
  enquanto o card está escondido e volta a acompanhá-lo quando ele reaparece,
  sem nenhum caso especial no desenho.

**"Está demorando" e "travou" são coisas diferentes.** Um bloco podia ficar dez
minutos em EXECUTANDO com a última linha de log de seis minutos atrás, e a
narração repetindo "ainda dando uma olhada no projeto" — uma frase que, naquele
momento, era mentira. Agora:
- O bloco mostra **"sem sinal há X"** em âmbar quando passa de 45s sem linha
  nova, no lugar do tempo total. O tempo total responde "faz quanto que
  começou"; o silêncio responde "ainda está vivo?", que é a pergunta real.
- A narração admite: passados 90s sem nenhum evento, ela diz há quantos minutos
  ele não dá sinal e lembra que o abortar existe, em vez de inventar atividade.
  O `orchestrator.lastEventAt` é quem sustenta as duas coisas.

**A narração ganhou repertório.** Duas frases alternando viram ruído: em três
minutos você já leu as duas e para de prestar atenção — e aí a mensagem perde a
única função que tem, que é você saber que ele continua vivo. Agora cada grupo de
ferramenta tem quatro ou cinco falas, mais duas listas transversais: gracinhas
(22% dos pulsos) e falas que citam o tempo decorrido (16%, só depois de três
minutos). Abertura, fecho, erro e recusa também sortearam — eram fixos e apareciam
igualzinhos em toda execução.

O `sortear` guarda duas memórias, e as duas são necessárias: a última frase dita
no geral (para não repetir de um pulso para o outro) e a última de **cada lista**
— sem a segunda, a mesma abertura saía em duas execuções seguidas, porque entre
elas passou um fecho e a memória global já tinha virado. As falas são curtas de
propósito: isso é lido em voz alta.

O aviso de silêncio também varia, mas nunca ameniza: quando ele está calado há
tempo demais, as três versões dizem há quanto tempo e lembram do abortar.

**Configurações (banco, Redis, voz) ficam em `workspace/settings.json`, não no
`.env`.** O `.env` continua sendo o que o `docker compose` lê para subir os
containers; `settings.json` é o que a tela de Configurações escreve, e
`apps/server/src/settings.ts` o funde por cima dos valores derivados do `.env`
(`config.ts` → `databaseParts`/`redisParts`/`voiceParts`). Dois arquivos porque
são dois públicos diferentes: o `.env` é editado à mão antes de subir o Docker;
o `settings.json` é editado pela tela, com o servidor já rodando.

**Trocar de banco não reinicia nada.** `settings.save` com `database` chama
`closeDb()` seguido de `initDb()` — o pool antigo fecha, um novo abre com a URL
nova, e o servidor manda `settings.state` com `dbApplied: true/false` conforme a
conexão pegou. Sem isso, cada ajuste na tela pediria para fechar os dois
terminais e abrir de novo.

**Voz não guarda nada em cache de módulo.** Antes `voice.ts` lia
`WHISPER_URL`/`PIPER_URL`/`PIPER_VOICE`/`VOICE_WAKE_WORD` uma vez, na
inicialização — trocar a voz pela tela não tinha efeito até reiniciar o
servidor. Agora toda função (`checkVoice`, `transcribe`, `synthesize`,
`wakeWord`, `matchesWake`) lê `getSettings().voice` na hora da chamada: o
efeito é imediato, inclusive numa fala já em andamento.

**O Piper carrega vozes sob demanda, uma vez cada.** `docker/piper/server.py`
mantém um `dict[str, PiperVoice]` em memória; a primeira síntese com uma voz
nova baixa o modelo do Hugging Face (`rhasspy/piper-voices`, ~60 MB) e cacheia
— trocas seguintes para a mesma voz são instantâneas. `GET /voices` devolve o
catálogo com `installed: true/false` para a tela pintar o que já foi baixado.

**O instalador Electron não embute o Docker.** Decisão consciente: Postgres,
Redis e (opcionalmente) Whisper/Piper continuam vindo do
`docker compose`. O instalador checa se o Docker está rodando e, se estiver,
já sobe os containers sozinho (`docker compose up -d`); se não estiver, avisa e
deixa abrir mesmo assim — o Tree funciona em modo degradado
(`banco offline`, reconectando a cada 10s) até o Docker subir. Tirar essa
dependência é uma ideia separada, ainda não decidida (ver "Ideias na mesa").

**O instalador roda o servidor com o Node embutido no Electron, não com um
Node.js instalado à parte.** `apps/desktop/main.cjs` sobe
`apps/server/src/index.ts` via `tsx`, chamando o próprio executável do Electron
com a variável `ELECTRON_RUN_AS_NODE=1` — é assim que o Electron vira "só o
Node" para um processo filho. Menos uma coisa para pedir para instalar.

---

## Pendências conhecidas

- [ ] **Consumo real da conta usa um endpoint não-documentado da Anthropic**
      (`apps/server/src/usage.ts`). Se um dia parar de responder ou mudar de
      formato, o painel Status volta sozinho para "CONSUMO DA SESSÃO" (a
      conta de tokens local, que sempre funciona) — não quebra, só fica menos
      preciso. Vale checar de vez em quando se `five_hour`/`seven_day`
      continuam vindo como antes.
- [ ] Subir e validar Whisper + Piper (item 1 acima).
- [ ] Se o volume do Postgres for antigo, aplicar a migração:
      `docker exec -i ia_coder_postgres psql -U iacoder -d iacoder < db\migrations\001_tree_dois_niveis.sql`
      (o log do servidor avisa: `a tabela "subjects" não existe`).
- [ ] Em banco que já existia, aplicar também a 002 — ela põe o Tree em escopo
      de projeto (`UNIQUE (project_path, slug)` e busca filtrada):
      `docker exec -i ia_coder_postgres psql -U iacoder -d iacoder < db\migrations\002_tree_por_projeto.sql`
      (o log avisa: `o Tree ainda é global`). Volume novo já nasce assim.
- [ ] Redis está no compose mas o servidor **ainda não usa** — entra quando
      houver mais de um agente em paralelo (pub/sub e fila).
- [ ] Embeddings: sem Ollama, o Tree cai para busca por texto (pg_trgm). Para
      ligar o semântico: `docker compose --profile ai up -d` e
      `docker exec -it ia_coder_ollama ollama pull nomic-embed-text`.
- [x] ~~Código morto da primeira versão da voz~~ — `useSpeechInput`, `useMicLevel`
      e `VoiceWave` foram removidos. A voz vive só no Talking
      (`useVoiceLoop` + `useVoiceOut`).
- [ ] `ResultPanel.tsx`/`.module.css` e `PromptBox.tsx`/`.module.css` ficaram
      no disco sem uso (o Result virou parte do Talking) — pode apagar quando
      quiser, nada importa mais deles.

## Ideias na mesa (nada começado)

- Painel de configuração de agentes e skills (hoje é editar direto no banco,
  pelo DBeaver ou outro cliente).
- Replay de um workflow: os dados já estão gravados (`links` guarda
  `activated_at`/`deactivated_at`) — falta a tela.
- Palavra de ativação 100% local com openWakeWord, se o Whisper pesar demais.
- **Listar os MCPs ativos dentro do painel de Skill.** A ideia: quando um
  pedido seu faz o Claude acionar um MCP para conseguir fazer algo, isso
  deveria aparecer como mais uma "skill" na lista. Ainda não peguei — precisa
  decidir como detectar (nomes de ferramenta vindo como `mcp__servidor__...`
  no `catalog.ts`?) e como descobrir quais MCPs estão configurados na sua
  máquina para nomear cada um direito.
- **Tirar a dependência do Docker.** Hoje Postgres/Redis/Whisper/Piper vêm do
  `docker compose`; o instalador só checa e avisa. Ideia para depois: Postgres
  embutido (algo como `pg-embedded` ou um binário portátil) e Redis trocado
  por algo em processo, para o IA_Coder rodar sem exigir Docker Desktop.

---

## Mapa do código

```
apps/server/src/
  index.ts        WebSocket, rotas de áudio, comandos, narração da execução
  claude.ts       o processo persistente do Claude Code
  shell.ts        o PowerShell escondido
  conversation.ts o cérebro do modo conversa (JSON: chat | ask | plan)
  orchestrator.ts traduz eventos do Claude em blocos, logs, setas e artefatos
  discovery.ts    varre o disco atrás dos agentes e skills instalados
  knowledge.ts    Tree: gravar assunto, ler os dois níveis, recuperar contexto
  auth.ts         estado da credencial e login
  usage.ts        consumo real da conta (5h + semana), via API não-oficial
  voice.ts        clientes do Whisper e do Piper (voz e wake word live-reload)
  db.ts           Postgres opcional, com reconexão e checagem de esquema
  settings.ts     workspace/settings.json — banco/Redis/voz, editável em runtime

apps/web/src/
  components/ConversationPanel.tsx   Talking: chat, imagem anexada, quem fala
  components/WireLayer.tsx           as setas
  components/TreePanel.tsx           os dois níveis do Tree
  components/Panel.tsx               casca dos painéis + a lupa + as abas
  components/StatusArchivesPanel.tsx Archives/Status num painel só, alternando
  components/SettingsPanel.tsx       tela de banco, Redis e voz
  store/useSession.ts                todo o estado, alimentado por eventos
  types/protocol.ts                  contrato — espelha apps/server/src/protocol.ts

apps/desktop/
  main.cjs        Electron: sobe o servidor (Node embutido), espera a porta,
                  abre a janela com apps/web/dist — o instalador Windows (.exe)
```

Contrato completo de eventos: [PROTOCOLO.md](PROTOCOLO.md).
Infraestrutura e o porquê dela: [DOCKER.md](DOCKER.md).

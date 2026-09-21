# Handoff do projeto — Tile Rescue Automation

Este documento é o ponto de entrada para qualquer pessoa ou agente que assuma
o projeto. Ele descreve o objetivo, o funcionamento do jogo, a arquitetura, o
histórico das decisões, o estado atual e a ordem recomendada para continuar.

## 1. Objetivo do projeto

Automatizar de forma conservadora um jogo Tile Rescue em um dispositivo Android
controlado por ADB. O objetivo da automação é completar cada nível, e não
maximizar a contagem opcional de sóis/recompensas. O agente deve:

1. capturar a tela do jogo;
2. localizar as cartas no tabuleiro e na bandeja;
3. identificar os ícones com a maior confiança possível;
4. inferir quais cartas estão livres e quais estão cobertas;
5. escolher uma jogada que forme trincas e preserve espaço na bandeja;
6. tocar somente em uma carta realmente disponível;
7. registrar o estado, a decisão e as imagens para auditoria.

O projeto não usa uma API remota de visão e não tenta ocultar que os comandos
são automação. A entrada é feita por ADB (`screencap` e `input tap`).

## 2. Como o jogo funciona

O tabuleiro contém cartas com ícones repetidos, organizadas em camadas. Só é
possível tocar numa carta livre: uma carta superior pode cobrir total ou
parcialmente uma carta inferior. A carta inferior pode ser visualmente
reconhecível sem ser jogável ainda.

As cartas tocadas vão para uma bandeja inferior, que tem sete posições no
layout observado. Quando três cartas do mesmo ícone se juntam, elas são
removidas. O risco principal é colocar cartas sem uma sequência de remoção e
encher a bandeja. O planejador, portanto, deve preferir uma trinca direta ou
uma sequência que revele uma trinca escondida.

### Regras estratégicas aprendidas

- Se já existem duas cópias de um ícone na bandeja e uma cópia livre, tocar a
  cópia livre completa a trinca (`complete-triple`).
- Se há uma cópia na bandeja e duas cópias livres no tabuleiro, isso é melhor
  do que começar um par de outro ícone (`complete-triple-potential`).
- Se a bandeja está vazia, três cópias livres vencem dois pares ou um singleton
  (`start-exposed-triple`).
- Se há duas cópias na bandeja e a terceira não está livre, o agente deve
  procurar a carta superior que libera uma cópia escondida
  (`release-hidden-match` ou `search-hidden-match`).
- Um par simples na bandeja é uma opção posterior (`make-pair-with-tray`).
- O agente deve parar antes de ocupar o último espaço sem uma correspondência
  direta (`safety-stop`).
- Quando grupos empatam em quantidade, o grafo geométrico desempata a carta
  dentro do grupo pela quantidade de alvos ocultos que ela cobre. A identidade
  do alvo só participa da prioridade quando foi confirmada; um alvo `unknown`
  nunca é tratado como uma trinca conhecida.
- A ordem espacial da detecção não é uma estratégia. Contagens, bandeja e
  dependências de cobertura têm prioridade sobre a primeira coordenada lida.

### Sóis e variantes visuais

O ícone `sun` pode aparecer com cartão branco, parcialmente dourado ou todo
dourado. O sol todo dourado é um item coletável/especial: se não for tocado,
perde gradualmente o dourado após alguns outros toques e volta a parecer um sol
normal. Essas imagens pertencem ao mesmo rótulo lógico `sun`, mas são
referências visuais diferentes no catálogo local.

O contador de sóis no header não é o objetivo operacional desta automação.

### Ícones variáveis por nível

Os ícones não são fixos entre níveis ou sessões. Já foram observados, entre
outros, `blueberry`, `butterfly`, `cake`, `sun`, `corn`, `carrot` e `chick`.
Por isso, nomes antigos como `whale`, `tile-0` ou grupos genéricos não devem
ser usados como rótulos humanos permanentes. O catálogo usa nomes canônicos em
inglês e aceita várias imagens de referência para o mesmo ícone.

## 3. Arquitetura atual

### `agent.js`

É o núcleo de visão geométrica e planejamento:

- captura ADB legada e funções de processamento de imagem;
- componentes conectados de pixels claros/dourados;
- detecção adicional de faces neutras/brancas;
- descrição de cor/forma e semântica legada;
- detecção dos slots da bandeja;
- cálculo de cartas disponíveis;
- hipóteses de cartas parcialmente cobertas;
- grafo de oclusão;
- planejador `chooseAction()`.

A ROI atual para o tabuleiro é:

```text
x=20..1060, y=430..1480  (captura observada de 1080x2340)
```

O header fica acima da ROI e a bandeja/controles ficam abaixo. Esse limite é
específico da escala observada no Samsung; se a resolução, densidade ou
orientação mudar, ele precisa ser recalibrado.

### `vision.js`

Gera o pacote auditável de visão:

- `screen.png`: tela capturada;
- `crops/`: recorte bruto de cada carta;
- `visible/`: recorte com a área estimada da carta superior mascarada;
- `contact-sheet.png`: mosaico dos recortes;
- `visible-contact-sheet.png`: mosaico das partes visíveis;
- `layer-graph-overlay.png`: diagnóstico das arestas de cobertura;
- `manifest.json`: coordenadas, papéis, tipos, confiança e relações;
- `layer-graph-validation.json`: validação das arestas;
- `analysis.json`: estado e decisão daquela observação.

O grafo é principalmente diagnóstico e também fornece uma pontuação geométrica
de liberação para desempates dentro de um grupo. Uma carta `hidden` nunca é
diretamente tocável; a ação deve usar uma carta `available` que cobre/libera a
carta escondida. O número de arestas, sozinho, não prova a identidade do alvo:
targets `unknown` não autorizam formar uma trinca nem substituem a classificação
do ícone.

### `local_ml.js`

É o classificador visual local, sem OpenAI ou outro serviço remoto:

- Transformers.js sobre ONNX Runtime;
- modelo padrão `Xenova/clip-vit-base-patch32`;
- quantização `q8`, executada em CPU;
- embeddings dos recortes comparados por similaridade de cosseno;
- catálogo persistente em `icon-library/catalog.json`;
- várias referências por rótulo, sem fazer uma média única dos exemplares;
- variantes do sol continuam sendo `sun` logicamente;
- abaixo do limiar, o resultado é `unknown`.

O estado de uma carta separa três identidades:

- `type`: nome canônico confirmado, como `sun`;
- `sessionGroupId`: grupo visual temporário da captura/nível, como
  `unlabeled-group-1`;
- `planningKey`: `type` quando confirmado ou `group:<sessionGroupId>` quando
  há somente uma identidade visual confiável.

Assim, um ícone novo pode participar de uma trinca sem ser batizado antes. Um
grupo desconhecido só é aceito para o planejamento quando possui pelo menos
duas ocorrências jogáveis e a oportunidade tem três cartas no total. Grupos
desconhecidos não são usados para exploração singleton, e cartas `hidden` não
ganham autorização de clique.

O limiar de similaridade do classificador é `0.88` por padrão. O limiar para
aplicar rótulos externos ao planejador é `0.75`. Um resultado `unknown` nunca
deve apagar uma semântica legada já confiável; ele permanece no JSON para
diagnóstico e pode preservar um `sessionGroupId` jogável quando houver
evidência suficiente. O limiar global de `0.88` não foi reduzido.

As heurísticas de cor verde que antes produziam `corn` ou `carrot` foram
desativadas: pimentões verdes permanecem `unknown` até uma referência nomeada
ou um grupo visual consistente. Isso evita transformar uma cor em um nome
canônico incorreto.

O recurso importante é `createClassifier()`: o encoder e os embeddings das
referências são carregados uma vez por execução e reutilizados entre os
movimentos.

### `play.js`

É o runner operacional principal. O fluxo é:

1. interpretar argumentos;
2. criar uma pasta de execução;
3. carregar o classificador local uma vez;
4. capturar a tela;
5. gerar o pacote de visão;
6. classificar todos os recortes em lote;
7. aplicar rótulos aceitos e preservar grupos visuais desconhecidos;
8. salvar `phase-map.json` com os grupos e evidências do nível;
9. chamar `chooseAction()`;
10. gravar a decisão;
11. em `--live`, tocar a coordenada e esperar a animação;
12. salvar a captura `after`, que vira a próxima observação.

O padrão é dry-run. Nenhum toque ocorre sem `--live`.

### `test.js`

Contém testes autocontidos do planejador, validação do grafo, aplicação de
rótulos, manifesto e regressão do detector da bandeja. A suíte obrigatória não
depende de screenshots em `/tmp`; replays visuais históricos são opcionais e
podem ser executados pelo runner com `--replay-dir`.

## 4. Biblioteca de ícones

O catálogo atual contém referências para:

```text
blueberry   2 referências
butterfly   1 referência
cake        2 referências
cupcake     1 referência
carrot      3 referências
pepper      2 referências
pudding     2 referências
sun         3 referências/variantes
```

Para adicionar um ícone novo descoberto num nível:

```bash
node local_ml.js --add-reference /tmp/pacote-de-visao tile-id blueberry
```

Para adicionar uma imagem independente ou uma variante:

```bash
node local_ml.js --add-image /tmp/sun-normal.png sun normal
node local_ml.js --add-image /tmp/sun-partial.png sun partial
node local_ml.js --add-image /tmp/sun-gold.png sun collectible
```

Use nomes em inglês, minúsculos, com letras, números, `_` ou `-`. O arquivo
`catalog.json` deve ser revisado junto com as imagens adicionadas.

## 5. Execução segura

Instalação e testes básicos:

```bash
npm install
node --check play.js
npm test
```

Dry-run recomendado:

```bash
npm run play -- --dry-run --level 23 --run-dir /tmp/tile-rescue-dry-run
```

Sem o modelo local, apenas para depurar a visão geométrica:

```bash
npm run play -- --dry-run --no-ml
```

Execução ao vivo, somente depois de revisar o JSON e as imagens:

```bash
npm run play -- --live --moves 1 --level 23
```

Parâmetros disponíveis:

```text
--dry-run             modo padrão; nunca toca
--live                habilita input tap
--moves N             quantidade máxima de movimentos; padrão 1
--device SERIAL       serial ADB; padrão RQCY903RJQN
--level N             apenas identificação/log; padrão 23
--run-dir PATH        diretório de auditoria
--settle-ms N         espera após toque; padrão 1200
--no-ml               desabilita o encoder local
```

O runner não usa moedas, anúncios, boosters ou botões de reforço.

## 6. Formato da pasta de execução

Exemplo:

```text
/tmp/tile-rescue-runs/level-23/<timestamp>/
├── run.json
├── move-000-before/
│   ├── before.png
│   ├── before.json
│   └── vision/
│       ├── screen.png
│       ├── manifest.json
│       ├── analysis.json
│       ├── local-predictions.json
│       ├── phase-map.json
│       ├── crops/
│       ├── visible/
│       ├── contact-sheet.png
│       └── layer-graph-overlay.png
└── move-000-after/
    ├── after.png
    └── after.json
```

O `run.json` registra dispositivo, nível, modo, modelo, quantidade de
referências, tempo de espera e quantidade de toques realmente executados.

## 7. Histórico de mudanças

### Nível 1 — baseline

O projeto começou como um planejador simples via ADB, com detecção por cor,
componentes conectados e seleção de peças pela ordem detectada. Essa versão
era útil para protótipos, mas confundia ordem espacial com prioridade e não
modelava cartas cobertas.

### Nível 2 — ROI contínua e bandeja

As duas fileiras fixas foram substituídas por uma área contínua do tabuleiro.
Header, bandeja, botões e anúncio passaram a ficar fora da ROI. O detector da
bandeja ganhou slots fixos, e o limiar foi reduzido para não perder ícones
azuis como `blueberry`.

### Nível 3 — prioridade de trincas

Os testes mostraram que formar um par não é o objetivo final. A prioridade foi
alterada para reconhecer explicitamente:

- trinca já completável na bandeja;
- uma cópia na bandeja + duas livres;
- três livres do mesmo ícone;
- só depois extensões simples de pares.

### Nível 4 — grafo de oclusão

Foi adicionado um grafo experimental `carta superior -> carta inferior` para
representar o fato de que uma cenoura ou cupcake pode estar visível, mas
bloqueado. O agente passou a sugerir clicar na carta superior que libera o
alvo, em vez de clicar num ícone aparentemente disponível sem relação.

O grafo teve falsos candidatos quando cartas se sobrepunham pouco ou quando a
região abaixo do tabuleiro era confundida com cartas. A ROI foi reduzida para
`y=1260`, as arestas fracas foram descartadas e cada alvo ficou limitado às
duas coberturas mais fortes.

### Nível 5 — pacote de visão

Foi criado um pacote com screenshots, recortes, contact sheets, máscara de
visibilidade, overlay e manifesto. Isso separou três problemas que antes
estavam misturados:

1. localizar a carta;
2. identificar seu ícone;
3. decidir se ela é tocável.

### Nível 6 — ML local e rótulos nomeados

Foi descartada a ideia de depender de uma IA remota. O projeto adotou
embeddings locais em CPU e um catálogo persistente com nomes como `blueberry`,
`butterfly`, `cake` e `sun`. Referências múltiplas passaram a cobrir ícones
variáveis entre níveis e as três aparências do sol.

### Nível 7 — runner consolidado

Os comandos Node inline foram substituídos por `play.js`. O modelo é carregado
uma vez, os movimentos são registrados por pasta e dry-run virou o padrão.
Também foi adicionada uma proteção para que previsões `unknown` não apaguem
rótulos legados úteis.

## 8. Limitações conhecidas e dívidas técnicas

- O grafo de oclusão ainda é uma hipótese geométrica, não uma segmentação
  perfeita. Relações precisam ser conferidas no overlay.
- A máscara da carta superior é retangular e aproximada; sombras e bordas
  arredondadas podem deixar pixels da carta de cima no recorte inferior.
- O CLIP local melhora a comparação com referências, mas não garante a
  identidade de uma carta cuja fração visível seja muito pequena.
- Um ícone sem referência pode permanecer `unknown`; o planejador evita tocar
  nele por segurança. É preciso cadastrar uma referência antes de confiar em
  novas níveis.
- O modelo consome CPU e RAM durante a carga. O desenho foi escolhido para um
  PC com 16 GB de RAM e sem GPU dedicada, mas o tempo de carga/inferência deve
  ser medido em cada máquina.
- O detector foi calibrado para 1080x2340. Outras escalas exigem nova
  calibração da ROI, dos slots da bandeja e do tamanho dos cartões.
- Existem screenshots históricos opcionais usados em diagnósticos anteriores,
  mas eles não são necessários para `npm test`:

```text
/tmp/tile_rescue_level23_clean.png
/tmp/agent_after_one.png
/tmp/agent_after_two.png
/tmp/tile-rescue-after-two.png
/tmp/tile_rescue_manual_carrot_check.png
```

## 9. Validação já feita

Validações que passaram durante a implementação:

- `node --check` em `agent.js`, `vision.js`, `local_ml.js` e `play.js`;
- parser da CLI do runner;
- proteção contra sobrescrita por `unknown`;
- `play.js --help`;
- dry-run com captura e geração de pacote quando o dispositivo estava
  disponível;
- `npm test` com estados determinísticos, sem dependência de `/tmp`;
- replay/planner visual em execuções anteriores, quando os screenshots estavam
  presentes.

Os screenshots históricos não são mais uma condição de sucesso da suíte. O ADB
também não deve ser presumido disponível para testes locais.

## 10. Próxima sequência recomendada

1. Confirmar `git status` limpo na `main` após o merge.
2. Reconectar/desbloquear o Samsung e confirmar `adb devices`.
3. Abrir o Tile Rescue e esperar o carregamento terminar.
4. Rodar `npm run play -- --dry-run --moves 1`.
5. Abrir a pasta de execução e conferir `before.png`, `contact-sheet`,
   `layer-graph-overlay.png`, `local-predictions.json` e `analysis.json`.
6. Se a recomendação estiver correta, executar somente uma jogada com
   `--live --moves 1`.
7. Comparar `after.png` com a próxima análise.
8. Cadastrar referências novas antes de permitir que um ícone desconhecido
   autorize jogadas.
9. Só depois ampliar `--moves` e ajustar thresholds/ROI.

Não alterar simultaneamente o detector, o classificador e o planejador sem
guardar uma captura de referência: isso dificulta saber se um erro veio da
localização, da identidade ou da estratégia.

Para cartas parcialmente cobertas, o pipeline mantém dois artefatos distintos:
o recorte bruto, útil para auditoria humana, e o recorte `visible/`, no qual a
interseção da carta superior é mascarada. O classificador também gera
referências equivalentes em `reference-variants/`, com a mesma máscara da carta
inferior, para não comparar um fragmento do ícone contra uma referência inteira
nem confundir pixels da carta superior com o alvo. O manifesto registra a
geometria em `visibleMask`. Essa técnica é semântica apenas: uma carta
`hidden` continua não clicável até que o grafo a torne disponível.
Correspondências parciais só podem virar nome quando a área visível é suficiente,
há margem sobre a segunda classe e existem pelo menos duas cópias completas
confirmadas do mesmo rótulo no nível; o limiar geral de `0.88` permanece aplicado
às cartas completas.

Os recortes agora respeitam o retângulo geométrico das cartas, `142×160` pixels.
Não usar novamente um quadrado `144×144` para validar a máscara de uma carta
inferior: o desalinhamento pode preservar a carta superior e remover a região
errada do alvo.

Depois da classificação, `applyVisionLabels()` sincroniza os rótulos dos nós
ocultos com as cópias dos endpoints nas arestas de `layerGraph` e
`occlusionGraph`. Isso é necessário para que o score de liberação reconheça
uma carta disponível que revela uma cópia do mesmo ícone; o alvo continua
`hidden` e não é clicável.

Quando um alvo possui mais de uma cobertura candidata, o pacote gera um
`visibleVariant` por cover, em vez de unir todas as máscaras. O classificador
registra `coverCandidates` e escolhe a máscara com maior evidência discriminativa
quando as hipóteses concordam no ícone. A escolha é copiada para
`hidden.selectedCover`; o planejador usa essa relação específica e não conta
uma carta superior concorrente como se também liberasse o alvo.

### Grupos visuais temporários e pudins do nível 23

Na captura `/tmp/tile-rescue-dry-run-20260920`, o modelo classificou quatro
cartas marrons como `unknown`, com alternativa `cake` entre 0,82 e 0,84,
abaixo do limiar nomeado de 0,88. O embedding, porém, colocou as quatro em
`unlabeled-group-1`. Antes desta correção, `chooseAction()` descartava
`unknown` e recomendava `start-exposed-pair` para os dois sóis.

O planejador agora usa o grupo temporário para retornar
`start-exposed-triple`, com `targetGroupId: unlabeled-group-1`, sem afirmar que
o ícone é `cake` ou `pudding`. Cada pacote também grava `phase-map.json`, que
permite auditar essa decisão e distinguir nomes canônicos de agrupamentos
locais.

## 11. Nível 23 concluída

Após a correção final de prioridade, o runner completou o nível 23 com nove
movimentos reais em `/tmp/tile-rescue-live-next9-20260920`. A sequência foi:

- três `cake`, removendo a trinca;
- três `pudding`, removendo a trinca;
- três `sun`, removendo a trinca.

O `run.json` registrou `executedMoves: 9` e `finishedAt` normalmente. Não houve
intervenção manual durante essa sequência. O estado final confirmou a conclusão
do nível; o próximo trabalho deve começar com uma nova captura e dry-run para o
nível seguinte, sem assumir que os ícones ou a disposição serão os mesmos.

O ajuste decisivo foi a ordem de `chooseAction()`: completar uma trinca
potencial (`1` na bandeja + `2` livres) vem antes de iniciar uma trinca nova;
uma trinca de três cartas livres vem depois, mas somente quando há três espaços
disponíveis; pares simples e buscas por cartas ocultas ficam abaixo dessas
opções seguras.

## 12. Preparação do nível 24

O nível 24 foi capturado sem toques em `/tmp/tile-rescue-level24-current.png`.
Os novos ícones identificados são `strawberry` e `peach`; o ícone laranja tem
formato de pêssego, não de manga. A biblioteca local agora contém quatro
referências de morango e três referências de pêssego, registradas em
`icon-library/catalog.json`.

O dry-run posterior reconheceu os quatro morangos livres com confiança entre
0,9854 e 0,9910 e classificou ocorrências parcialmente cobertas do pêssego
com evidência `peach`. Nenhum movimento do nível 24 foi executado. Antes de
jogar, fazer nova captura/dry-run quando a tela estiver novamente no tabuleiro;
não assumir que uma carta atualmente `hidden` pode ser tocada.

## 13. Detecção de conclusão

O runner verifica o estado imediatamente após cada toque. Se não houver cartas
`available`, `hidden`, na bandeja ou componentes detectados, grava
`completed: true` com `completionReason: "empty-board"` no `run.json` e no
`after.json`, encerrando a execução. `safety-stop` e `no-action` são registrados
separadamente em `stopReason`.

Antes de aceitar `empty-board`, o runner valida pontos do fundo teal do jogo
na captura. Isso evita marcar como concluído um aparelho bloqueado, carregando
ou com a tela apagada.

## 14. Próxima melhoria: desempenho

Na execução real do nível 24, `mlSummary.inferenceMs` ficou entre 20,6 e
28,1 segundos por captura, enquanto o intervalo total entre capturas ficou em
aproximadamente 30–36 segundos. O `settleMs` é 1,2 segundo; a inferência local
em CPU é o principal gargalo conhecido.

Ainda falta instrumentar separadamente captura, visão, escrita do pacote,
ADB, espera pós-toque e planejador. Fazer essa medição após concluir o nível 24
e só então otimizar a inferência, preservando os limiares e as máscaras seguras.

## 16. Retomada e conclusão real do nível 24

O primeiro `--moves 999` do nível 24 teve um falso positivo porque o ROI antigo
terminava em `y=1260`; essa execução não deve ser usada como evidência de
conclusão. Depois do ROI corrigido para `y=1480`, a retomada foi auditada em
`/tmp/tile-rescue-level24-live-complete-20260920` e registrou:

- `executedMoves: 4`;
- `completed: true`;
- `completionReason: "empty-board"`;
- `stopReason: null`.

A captura `move-003-after/after.png` mostra a bandeja vazia e nenhum cartão no
tabuleiro. O nível 24 foi concluído sem toques manuais.

Durante a retomada foram corrigidos dois problemas de geometria e identidade:

- os slots da bandeja deste layout usam centros espaçados em 120 px, não 107;
  o passo incorreto deslocava progressivamente os recortes para a carta vizinha;
- os recortes da bandeja agora usam uma janela menor e centralizada, e a
  ocupação exige luz nos dois lados do slot. Isso rejeita a borda de uma carta
  anterior como um novo slot vazio, sem perder o pimentão verde real.

Também foi adicionado um caso conservador de promoção de grupo visual: pelo
  menos duas cartas jogáveis do mesmo grupo desconhecido podem receber um nome
  canônico somente quando há um exemplar nomeado confirmado no mesmo estado e
  ambas têm a mesma alternativa semântica forte. Esse caso permitiu reconhecer
  dois sóis na bandeja, que estavam abaixo de `0.88` por causa do recorte, e
  completar a trinca sem reduzir globalmente o limiar.

O aparelho bloqueou a tela durante uma tentativa intermediária; o runner
  registrou `screenReady: false` e não considerou aquilo uma vitória. A tela foi
  desbloqueada antes da retomada final. Em execuções longas, manter o aparelho
  acordado ou verificar o bloqueio antes de iniciar continua sendo necessário.

## 15. Correção do ROI após falso positivo no nível 24

O primeiro teste real com `--moves 999` parou após 24 toques com
`completed: true`, mas `move-023-after/after.png` ainda mostrava três cartas
inferiores. Elas ocupavam aproximadamente `y=1292..1423`, fora do ROI anterior
que terminava em `y=1260`.

O ROI foi corrigido para `y=1480`, mantendo a bandeja fora da região. O nível
24 permanece incompleto até uma nova análise confirmar que não existem cartas
visíveis ou ocultas. Não usar o `run.json` anterior como prova de conclusão.

A condição de conclusão também exige `detected=0`, além de `available=0`,
`hidden=0` e `tray=0`. O replay da captura encontrou as três cartas inferiores
em `y=1367` após a correção.

## 17. Instrumentação e caminho rápido — 2026-09-20

Foi adicionada instrumentação por movimento em `timing.json`, separando captura
ADB/decode, geometria, grafos, recortes, artefatos, leitura de arquivos,
embeddings, aplicação de rótulos, `chooseAction()`, tap e settle. O runner
também aceita `--replay-dir PATH` em dry-run para reprocessar
`move-XXX-before/before.png` sem ADB ou input.

No replay de quatro capturas do nível 24, o modo completo mediu média de
`5,03 s` por movimento. A decomposição média foi: captura/decode `17 ms`,
geometria `162 ms`, grafos `188 ms`, artefatos completos `1,08 s`, geração de
referências mascaradas `287 ms`, reembedding dessas referências `2,94 s`,
embeddings das cartas `285 ms`, aplicação de rótulos `0,8 ms` e
`chooseAction()` `0,6 ms`.

O gargalo era o reembedding das referências mascaradas para cartas ocultas a
cada observação. O modo completo agora mantém cache por referência e pela
geometria exata da máscara, sem misturar máscaras diferentes.

O modo `--fast` mantém a ROI `x=20..1060, y=430..1480`, os slots com passo de
120 px, o limiar global `0.88`, a aplicação conservadora de rótulos, a
proteção contra cartas ocultas e a detecção de conclusão. Ele classifica
cartas disponíveis e da bandeja, mantém cartas `hidden` no grafo sem permitir
que autorizem taps, e omite overlays/contact sheets e variantes não necessárias
à decisão. O modo completo continua sendo o padrão para auditoria. `--live-fast`
é apenas o atalho que combina `--live` e `--fast`; não foi usado nesta
validação.

No replay do nível 24, `--fast` produziu média de `0,73 s` por movimento e
máximo de `0,79 s`. As quatro razões, alvos e coordenadas coincidiram com o
modo completo. Esse resultado é local/replay; ainda não é uma medição ao vivo
do caminho rápido.

### Medição real controlada no nível 25

Com autorização explícita, foram executados exatamente três movimentos em
`/tmp/tile-rescue-level25-live-profile-20260920`, usando o modo completo:

1. `start-exposed-pair`, `butterfly`, `(472,725)`;
2. `make-pair-with-tray`, `butterfly`, `(608,859)`;
3. `search-hidden-match`, `(209,584)`.

O run terminou com `executedMoves: 3`, sem conclusão e sem `stopReason`. Os
tempos totais foram `36,35 s`, `20,43 s` e `19,54 s`, média de `25,44 s`. No
primeiro movimento, ML consumiu `29,03 s`, sendo `24,15 s` em referências
mascaradas e `1,90 s` nas cartas; a captura ADB inicial consumiu `3,24 s`, os
artefatos `1,94 s`, o tap `243 ms`, o settle `1,20 s` e a captura após o toque
`2,59 s`. Nos movimentos seguintes, ML consumiu `13,06 s` e `12,02 s`.

Essa execução confirma no aparelho que o atraso está concentrado no caminho
completo de ML, com contribuição relevante de captura ADB e auditoria;
`chooseAction()` continua irrelevante para a latência. Nenhum movimento
adicional deve ser executado nesta investigação sem nova autorização explícita.

### Correção de identidade do nível 25

O catálogo não possuía `carrot`. No primeiro frame do nível 25 havia três
cenouras livres: `(209,584)`, `(600,720)` e `(472,1261)`. As duas primeiras
ficaram `unknown` e a terceira foi confundida com `strawberry` (`0.8804`).
Como o grupo desconhecido não tinha três membros, o planejador escolheu duas
borboletas.

As três imagens limpas foram cadastradas como referências `carrot`. O replay
`/tmp/tile-rescue-level25-carrot-replay-20260920` passou a reconhecer as três
com confiança `0.9806`, `0.9803` e `0.9830` e recomendar
`start-exposed-triple` para `carrot`.

## 18. Hipótese da captura ADB e experimento `--raw-capture` — 2026-09-20

O teste ao vivo com `--live-fast` confirmou que o modo rápido reduziu a
inferência para aproximadamente `336 ms`, mas o intervalo completo entre
movimentos ainda ficou em média em `6,06 s`. A decomposição média foi:
captura ADB `2,60 s`, análise/ML e artefatos aproximadamente `1,69 s`, tap
`124 ms`, settle `1,20 s` e processamento da captura seguinte cerca de
`2,42 s`. Portanto, a captura ADB virou o próximo gargalo observável depois de
remover o reembedding caro.

A hipótese testada foi: **o atraso do screenshot está principalmente na
codificação PNG executada no dispositivo, e não na transferência ADB nem no
decode local**. A medição direta encontrou PNG de aproximadamente `1,65 MB`
em `2,30--2,43 s`, contra captura bruta de aproximadamente `10,1 MB` em
`1,12 s`. O formato bruto observado começa com cabeçalho little-endian de 16
bytes (`width`, `height` e campos de formato) seguido por
`width*height*4` bytes RGBA.

Foi adicionado o modo experimental `--raw-capture`. Ele chama
`adb exec-out screencap` sem `-p`, valida dimensões e tamanho do payload, e
entrega RGBA diretamente ao pipeline; o caminho PNG padrão não foi alterado.
Se o formato do aparelho mudar ou não for exatamente RGBA8888, a captura
bruta falha explicitamente em vez de interpretar pixels incorretamente.

### Comparação no dispositivo, sem toque

Foram executados dois dry-runs `--fast` de um movimento no nível 25, usando o
mesmo estado do aparelho e sem input tap:

| caminho | captura ADB | conversão/parse | análise | ML | artefatos | decisão |
|---|---:|---:|---:|---:|---:|---|
| PNG | `2695 ms` | `90 ms` | `1523 ms` | `446 ms` | `202 ms` | cenoura em `(472,1261)` |
| bruto RGBA | `1378 ms` | `0,1 ms` | `1412 ms` | `424 ms` | `204 ms` | cenoura em `(472,1261)` |

Runs: `/tmp/tile-rescue-level25-png-capture-20260920` e
`/tmp/tile-rescue-level25-raw-capture-20260920`. O `totalMoveMs` começa
depois da captura inicial; a captura permanece registrada separadamente em
`timing.json`. O modo bruto reduziu a captura observada em aproximadamente
`1,32 s` e preservou a decisão, a validação teal, a ROI, o grafo de ocultação,
o limiar `0.88`, o tratamento de `unknown` e a proteção contra cartas
parcialmente cobertas.

Isso torna a captura bruta uma candidata forte para o próximo teste, mas ainda
não autoriza torná-la padrão: é preciso comparar visualmente PNG e RGBA em
mais estados, confirmar estabilidade do cabeçalho Android e medir o caminho
ao vivo completo. Mesmo economizando cerca de `1,3 s` por captura, o settle de
`1,2 s` e o processamento pós-toque impedem concluir que a meta de menos de
`2 s` entre movimentos já foi atingida. Nenhum toque foi enviado durante este
experimento.

O prompt de continuidade está em
[`docs/NEXT-AGENT-PROMPT.md`](NEXT-AGENT-PROMPT.md).

## 19. Validação do cabeçalho bruto e redução segura do pós-toque — 2026-09-20

O cabeçalho retornado pelo aparelho foi confirmado contra a implementação
oficial de `screencap`: `width=1080`, `height=2340`, `pixelFormat=1`
(`RGBA_8888`) e `dataspace=2`. O parser agora rejeita explicitamente qualquer
pixel format diferente de `RGBA_8888`, além de exigir o payload exato
`width*height*4`; o cabeçalho aceito fica registrado em `timing.capture.rawHeader`.

Foram feitas três capturas PNG e três RGBA consecutivas sem toque enquanto o
aparelho estava fora do tabuleiro. O PNG mediu `452--1800 ms` de ADB e o RGBA
`1006--1080 ms`; todas ficaram com `screenReady: false` e sem cartas jogáveis,
portanto servem apenas como medição de transporte e rejeição segura da tela
incorreta, não como validação visual do nível.

Nos dois runs úteis já existentes do nível 25, a inspeção visual preservou a
mesma cenoura em `(472,1261)`, os mesmos nove disponíveis, três cartas na
bandeja, grupos nomeados e ação `complete-triple-potential`. As hipóteses
geométricas variaram entre `33/32` ocultas e `61/59` arestas entre capturas;
ambos os grafos continuaram válidos. Isso não é evidência suficiente para
fazer RGBA substituir PNG como padrão, embora a captura bruta tenha economizado
aproximadamente `1,32 s` naquele estado. PNG continua padrão; RGBA permanece
opt-in até haver comparação em vários estados de tabuleiro e um teste ao vivo
autorizado.

O `--fast` agora adia o `postTapSummary` somente quando ainda existe uma
próxima iteração. A mesma captura `after` é analisada no início da iteração
seguinte, antes de qualquer novo toque; no último movimento permitido a
checagem continua imediata. Isso remove a repetição medida de aproximadamente
`0,76--0,78 s` por movimento, preservando a validação teal, a detecção de
conclusão e o caminho completo de auditoria. Esta alteração ainda não foi
testada ao vivo nesta sessão. Quando a conclusão é encontrada na análise
seguinte, o `after.json` anterior também recebe `completed: true` e
`completionDetectedOn: "next-analysis"`.

## 20. Referências do estado atual — 2026-09-20

Na captura `/tmp/tile-rescue-device-readiness-20260920`, o recorte disponível
`board-3-472-859` foi identificado visualmente como milho e
`board-4-608-859` como raposa. Eles foram cadastrados sem tocar no aparelho:

- `corn/board-3-472-859.png`;
- `fox/board-4-608-859.png`.

O replay `/tmp/tile-rescue-device-readiness-replay-icons-20260920` reconheceu
os dois como `corn` (`0,9906`) e `fox` (`0,9873`). `blueberry` já estava no
catálogo com duas referências. O grupo em `(270,790)` era uma hipótese de sol
oculto, não milho nem raposa. Nenhum teste ao vivo foi iniciado após esse
cadastro.

## 21. Regressão estratégica do modo rápido — 2026-09-20

No primeiro frame do teste real, havia dois sóis livres e alvos ocultos do
mesmo grupo. O replay completo escolheu `sun` em `(470,1260)`, mas
`--live-fast` escolheu `cupcake` em `(200,590)`, pois deixou todos os ocultos
como `unknown`. O modo rápido atual é seguro contra clique em ocultas, mas
degrada o desempate do planejador. A correção deve manter a análise semântica
 das ocultas e otimizar apenas cache, referências ativas e recomputação local.

## 22. Camada por contorno e brilho relativo — 2026-09-20

Foi implementada uma separação mais segura entre proximidade geométrica e
oclusão real. Os candidatos não são mais suprimidos por uma caixa retangular
de `120x135`; a deduplicação de centros próximos usa distância euclidiana de
`72 px`. Cada candidato também registra um perfil de contorno, baseado no
contraste local ao redor da face, e o grafo calcula o brilho relativo da face
em amostras afastadas do ícone.

Uma carta só pode ser retirada de `available` quando há uma candidata
sobreposta com contorno consistente, exposição pelo menos equivalente e brilho
relativo pelo menos `30` pontos maior. Isso não usa a cor do ícone: cartas
colecionáveis douradas continuam sendo analisadas pela borda e pelo brilho
relativo da própria face.

No replay completo do primeiro frame do nível 25, em
`/tmp/tile-rescue-level25-edge-full-replay-20260920-v2`, os quatro sóis foram
reconhecidos: dois ficaram disponíveis e dois permaneceram na camada inferior.
O planejador escolheu `sun` em `(470,1260)`, com `targetCount=4`, em vez de
`cupcake`. Não houve toque no device. O tempo adicional de geometria e grafo
foi aproximadamente `105 ms` sobre o replay anterior; a inferência ML e o
limiar `0.88` não foram alterados.

O resultado preserva a proteção contra cartas parcialmente cobertas: brilho
ou cor isolados não promovem uma candidata para clique. O caso ambíguo deve
continuar fora de `available` até haver evidência de contorno e cobertura.

## 23. Correção das duas cartas centrais livres — 2026-09-20

O replay visual mostrou que a hipótese anterior ainda estava errada: havia
quatro sóis livres, não dois. As duas cartas centrais eram detectadas pelo
scan, mas a regra de cobertura sem direção interpretava as cartas brancas
abaixo delas como se estivessem por cima. Além disso, o NMS favorecia um ponto
intermediário entre as duas faces douradas.

A correção agora não trata uma carta normal abaixo de uma carta colecionável
como cobertura, recupera cartas colecionáveis com visibilidade alta e contorno
forte de quatro lados, prefere esses centros fortes a pontos intermediários e
mantém candidatos realmente ocultos no `layerGraph`.

No replay completo `/tmp/tile-rescue-level25-center-suns-full-replay-20260920`,
o resultado foi exatamente quatro `sun` em `available`: `(880,595)`,
`(480,730)`, `(590,730)` e `(480,1260)`. Outros sóis foram reconhecidos em
`hidden`, incluindo `(670,655)`, `(700,735)` e `(380,1265)`. A ação foi
`start-exposed-triple`, alvo `sun`, sem qualquer toque no device.

## 24. Marcação visual das detecções — 2026-09-20

Para auditar visualmente o que o agente viu, usar sempre uma cópia da captura
original e marcar os centros retornados pelo runner. O procedimento é:

1. Executar um dry-run, sem `--live` e sem `input tap`, salvando `before.png`,
   `analysis.json` e o pacote de visão:

   ```text
   node play.js --moves 1 --level 25 --run-dir /tmp/tile-rescue-current-eval
   ```

2. Ler `move-000-before/vision/analysis.json`. Para cartas clicáveis, usar
   `state.available`; para cartas inferiores, usar `state.layerGraph.hidden`.
   Os campos `cx` e `cy` são os centros de clique. Não usar `x` e `y` como
   centro: eles são o canto superior esquerdo do recorte.

3. Desenhar Xs deterministicamente sobre uma cópia de `before.png`, usando
   SVG/Sharp. Cada X deve ter traços vermelhos com contorno preto, sem crop,
   resize ou alteração da imagem. O original deve permanecer intacto.

4. Abrir a cópia com `view_image` e confirmar se cada X caiu sobre a carta
   correta. Se o objetivo for comparar camadas, gerar arquivos separados
   para `available` e `hidden`, em vez de misturar as duas listas.

A edição generativa de imagem não é adequada para essa auditoria: ela pode
   redimensionar a captura ou deslocar as marcas. A anotação determinística
   por coordenadas é a fonte de verdade. No estado avaliado nesta data, a
  cópia anotada foi `/tmp/tile-rescue-current-eval-20260920/available-suns-marked.png`.

## 25. Correção do sol falsamente livre — 2026-09-20

Na captura atual, o sol em `(670,665)` estava sendo marcado como `available`,
embora estivesse sob outro sol disponível, perto do milho. A causa era que o
grafo comparava a carta somente com candidatas do scan; cartas já classificadas
como disponíveis não participavam da verificação de cobertura.

O grafo agora compara também cartas disponíveis entre si, mas só aceita essa
demão quando a cobertura tem o mesmo tipo semântico confirmado, contorno
consistente, exposição equivalente e brilho relativo materialmente maior.
Cartas com contorno quase completo (`completeness >= 0.94` e
`minSide >= 0.90`) ficam protegidas contra demão por vizinhos, preservando os
dois sóis centrais realmente livres. A margem de brilho usada nessa verificação
é `30` pontos.

Validação no replay da captura atual
`/tmp/tile-rescue-current-eval-fixed4-full-20260920`: quatro sóis em
`available` — `(880,591)`, `(472,725)`, `(608,725)` e `(472,1261)` — e o sol
em `(670,665)` em `hidden`. A validação da imagem original em
`/tmp/tile-rescue-level25-center-suns-fixed4-full-20260920` também manteve os
quatro sóis livres, incluindo `(590,730)`. Ambos foram dry-runs, sem `--live`
ou toques.

As inferências ML devem ser executadas sequencialmente: duas análises completas
em paralelo pressionaram a memória e foram interrompidas antes de produzir
`analysis.json`. Nenhum toque ocorreu; uma execução isolada posterior concluiu
normalmente.

## 27. Implementação interrompida por pressão de memória — 2026-09-20

Foi iniciada uma otimização segura para tornar a análise completa rápida sem
reutilizar estado do tabuleiro. A implementação em `local_ml.js` agora possui:

- cache LRU limitado de embeddings de recortes, indexado por hash SHA-256 do
  conteúdo e pelo papel da carta; uma carta revelada ou uma máscara alterada
  não reutiliza o embedding anterior;
- cache LRU limitado de referências mascaradas e dos arquivos gerados pela
  máscara, indexado pela referência e pela geometria exata da máscara;
- seleção das referências mascaradas mais prováveis, mantendo pelo menos uma
  referência por rótulo da biblioteca e sempre acrescentando as referências
  completas como fallback. Visão, grafo, camadas e ação continuam sendo
  recalculados em toda captura.

O primeiro replay da nova estratégia caiu de aproximadamente `38,9 s` de ML
para aproximadamente `1,9 s` no primeiro frame, mas revelou uma falha na chave
de seleção: os protótipos usavam caminho relativo e as referências mascaradas
usavam caminho absoluto. Isso fez a etapa mascarada não encontrar algumas
referências e reduziu a quantidade de rótulos ocultos nomeados. Foi corrigido
adicionando `filePath` aos protótipos, porém a validação posterior dessa última
correção ainda não foi concluída.

Durante a tentativa de replay posterior, o sistema exibiu novamente
`Application Stopped — Device memory is nearly full`; o processo foi
interrompido e não há runner residual. A última tentativa era replay local,
sem `--live` e sem toque; portanto não houve novo movimento no device nessa
etapa.

Para continuar com segurança:

1. executar um replay completo isolado de um frame com
   `/tmp/tile-rescue-level25-live-full-raw-3moves-20260920`;
2. comparar `state.available`, `state.layerGraph.hidden`, rótulos ML e ação
   contra `/tmp/tile-rescue-level25-live-frame0-fixed-full-replay-20260920`;
3. confirmar os hits/misses em `timing.json` e que a classificação mascarada
   voltou a nomear as ocultas esperadas;
4. só então testar vários frames em dry-run. Não usar `--fast` nem executar
   novo teste ao vivo até essa equivalência ser confirmada.

## 26. Teste ao vivo de três movimentos — 2026-09-20

Com autorização explícita, foram executados exatamente três movimentos no nível
25 usando análise completa, `--live`, captura `--raw-capture` e
`/tmp/tile-rescue-level25-live-full-raw-3moves-20260920`. As ações foram:

- movimento 0: `sun` em `(473,1261)`, confiança `0,9173`;
- movimento 1: `sun` em `(608,725)`, confiança `0,9057`;
- movimento 2: `sun` em `(530,1270)`, confiança `0,9042`.

O processo terminou normalmente após o terceiro toque e salvou `before` e
`after` para cada movimento. As capturas brutas ADB levaram `1893`, `938` e
`1276 ms`; o parse RGBA ficou abaixo de `1 ms` em cada caso. O primeiro frame
ao vivo ainda expôs o falso sol coberto como `unknown` geométrico em
`available`; ele não era elegível para clique, mas isso foi corrigido depois
para que a carta também seja removida de `available` e permaneça em `hidden`.
O replay ML posterior do mesmo frame confirmou quatro sóis livres e o falso
sol `(670,655)` em `hidden`, sem novo toque.

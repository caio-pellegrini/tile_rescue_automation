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

Contém replay de screenshots, testes do planejador, validação do grafo,
aplicação de rótulos e regressão do detector da bandeja. Os replays dependem de
arquivos temporários que não estão versionados; veja a seção de validação.

## 4. Biblioteca de ícones

O catálogo atual contém referências para:

```text
blueberry   2 referências
butterfly   1 referência
cake        2 referências
cupcake     1 referência
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
- O replay atual depende destes screenshots temporários, que precisam ser
  recriados para executar a suíte completa:

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
- replay/planner em execuções anteriores, quando os screenshots temporários
  estavam presentes.

Na última revisão, `npm test` não pôde completar porque os screenshots acima
não estavam mais em `/tmp`. Isso é ausência de fixture, não uma falha
diagnosticada do runner. O ADB também ficou sem o dispositivo ao final da
revisão; nenhuma jogada ao vivo deve ser presumida.

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

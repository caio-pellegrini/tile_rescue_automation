# Diário de experimentos

## Estado inicial

- Dispositivo de teste: Samsung conectado por ADB.
- Resolução observada: `1080x2340`.
- Região útil do tabuleiro: entre o header e a bandeja, aproximadamente
  `x=20..1060`, `y=430..1480`.
- A bandeja ocupa uma região separada e tem sete posições sobrepostas.
- O objetivo operacional é completar o nível; a contagem de sóis não é uma
  condição necessária.

## Descobertas de planejamento

- Uma trinca já representada na bandeja deve ser concluída antes de iniciar
  outro grupo.
- Se a bandeja tem um par e a terceira peça não está exposta, vale procurar
  uma carta bloqueada antes de inserir uma peça sem relação.
- Ver uma carta parcialmente coberta é diferente de considerá-la jogável.
  O agente precisa modelar uma dependência `carta de cima -> carta de baixo`.
- A ordem espacial da detecção não é uma política: grupos visíveis e peças na
  bandeja precisam ser considerados antes da coordenada.

## Testes já realizados

- A estratégia de pares expostos foi validada com replay: três cupcakes vencem
  dois sóis como primeiro grupo.
- O primeiro grafo de oclusão foi validado com uma cenoura parcialmente atrás
  de um cupcake: tocar o cupcake revelou a cenoura e a trinca pôde ser
  concluída.
- Em um estado posterior, cupcakes parcialmente visíveis foram classificados
  como milho. Isso mostrou que a assinatura de cor é insuficiente quando a
  maior parte do ícone está coberta.
- Também foi observada uma relação incorreta em que um sol foi associado a uma
  carta que não estava realmente abaixo dele. O problema é de inferência
  geométrica e de classificação, não de uma única coordenada de clique.

## Validação visual da separação dos sóis

Na captura do nível 23, o detector estava contando cartas douradas bloqueadas
como sóis jogáveis e confundindo uma delas com patinho. A correção adicionou:

- uma segunda detecção baseada nas faces neutras/brancas das cartas;
- a distinção `variant=normal|collectible`;
- uma regra de sobreposição diagonal para retirar cartas douradas bloqueadas
  da lista `available`;
- uma regra específica para diferenciar patinho e sol quando ambos têm a mesma
  paleta amarela/laranja.

Resultado do teste visual, sem tocar na tela:

- primeiro plano: sol normal, patinho, dois milhos e outro sol normal;
- bandeja: dois cupcakes;
- segundo plano: cupcake parcialmente coberto pelo patinho;
- ação sugerida: clicar no patinho em `(682,715)` para revelar o cupcake em
  `(612,735)`.

Essa foi a primeira validação em que a recomendação coincidiu com a estratégia
humana esperada.

## Dívida técnica: classificador visual

Na validação seguinte, a bandeja tinha um patinho e dois sóis, mas o terceiro
sol foi classificado como patinho. Os dois sóis tinham assinaturas praticamente
iguais; o erro veio de uma regra de limiar que interpretava uma quantidade
menor de laranja como patinho.

Correção imediata: exigir os pixels escuros característicos dos olhos/bico do
patinho antes de aplicar essa regra. Depois, a integração de um modelo visual
local foi implementada para comparar recortes com referências nomeadas. Ela
melhora a identidade dos ícones, mas ainda não resolve sozinha localização ou
oclusão de cartas muito pequenas.

## Mudança atual

Foi adicionado um pacote de visão para inspecionar o estado inteiro em lote:
recorte por carta, contact sheet e manifesto estruturado. Ele permite ao
classificador local comparar todos os recortes de um estado em uma única
inferência em lote, mantendo a geometria e o planejador separados.

## Próximos experimentos

1. Comparar os recortes reais das cartas parcialmente cobertas com as imagens
   de referência da bandeja.
2. Melhorar a detecção de centros e retângulos antes de aumentar a confiança
   semântica.
3. Testar um classificador visual em lote com limiar de confiança e resposta
   top-k.
4. Recalcular somente o subgrafo afetado após cada toque.
5. Manter modo de simulação e validação visual antes de permitir uma sequência
   de jogadas ao vivo.

## Ícones variáveis por nível

Foi observado que ao sair e voltar para o jogo o conjunto de ícones pode mudar.
Isso invalida uma política baseada apenas em nomes e limiares de cor fixos. A
geometria do tabuleiro continua reutilizável, mas a identidade das peças deve
ser criada por nível.

O fluxo implementado para isso é:

1. gerar um pacote com captura, recortes, referências da bandeja e grafo;
2. opcionalmente classificar tudo em lote com `local_ml.js`;
3. receber `groupId` dinâmico para peças visualmente iguais;
4. aplicar somente rótulos com confiança mínima ao planejador;
5. guardar uma captura antes/depois de cada jogada para auditoria.

O modelo visual permanece local e controlado pelo runner; ele é chamado uma vez
por estado observado e o encoder fica carregado em memória durante a execução.

## Runner consolidado

O fluxo operacional foi consolidado em `play.js`. O modo padrão é dry-run e
não envia toques; `--live --moves N` habilita explicitamente a execução. Cada
movimento ganha uma pasta com `before/`, `after/`, o pacote de visão, as
predições do classificador e o JSON da decisão. O arquivo `run.json` registra
dispositivo, nível, modo, modelo, quantidade de referências e movimentos
executados.

O runner também elimina a sequência anterior de comandos Node inline. Isso
reduz risco de quoting do shell, facilita reproduzir uma rodada e permite
reutilizar o modelo local sem recarregá-lo a cada movimento. A observação
posterior ao toque é reaproveitada como o próximo `before`, reduzindo trabalho
redundante.

## Diagnóstico da referência com ícones novos

Uma captura posterior do nível 23 trouxe blueberries, borboletas, bolos,
alfaces e sóis colecionáveis, com a bandeja vazia. O detector estrutural
encontrou apenas seis cartas expostas e os rótulos antigos (`whale` e
`tile-0`) se mostraram inadequados para ícones variáveis. Eles foram substituídos
por grupos visuais locais (`visual-group-N`) quando não existe uma semântica
conhecida. O detector estrutural também encontrou hipóteses parcialmente
ocultas, mas o contact sheet mostrou que identidade e geometria precisam ser
tratadas separadamente.

### Biblioteca de ícones nomeados

O agrupamento temporário foi substituído por uma biblioteca persistente em
`icon-library/catalog.json`. Cada referência recebe um nome canônico em inglês,
como `blueberry`, `butterfly` ou `cake`, e pode ter várias imagens para cobrir
variações entre níveis. O encoder calcula embeddings dessas referências e
compara os recortes novos contra elas. Sem correspondência acima do limiar, o
rótulo humano permanece `unknown`; nenhum identificador técnico é apresentado
como se fosse o nome do ícone.

Como validação inicial, a captura atual cadastrou duas referências de
`blueberry`, duas de `cake`, uma de `butterfly` e uma de `sun`. A classificação
do mesmo pacote retornou esses quatro nomes com confiança entre 0,9898 e 1,0.
O `sun` também recebeu exemplares `collectible` e `partial`; eles permanecem
como referências separadas, mas continuam produzindo o mesmo rótulo lógico.

### Priorização de trincas

O planejador foi ajustado para não confundir uma extensão de par com o objetivo
final. Agora uma peça na bandeja acompanhada de duas cópias expostas retorna
`complete-triple-potential`; com a bandeja vazia, três cópias expostas retornam
`start-exposed-triple`. A extensão simples de par só fica como fallback depois
dessas oportunidades.

Após as duas primeiras jogadas, a captura final mostrou `blueberry + butterfly`
na bandeja. O detector havia perdido o blueberry porque o limiar de luminosidade
era alto demais para um ícone azul; o limiar foi reduzido de `1500` para `1000`.
Os divisores vazios permanecem abaixo desse valor, e uma regressão agora exige
que os dois cartões sejam detectados.

Isso confirmou duas dívidas separadas:

1. a proposta de retângulos/camadas precisa melhorar antes de autorizar cliques;
2. a identidade visual deve ser dinâmica e não depender de nomes ou cores
   fixas.

## Implementação local de ML

Foi adicionado um encoder visual local quantizado em CPU. Ele transforma cada
recorte em embedding e agrupa por similaridade, produzindo `groupId` local à
nível. A implementação não usa API remota, não exige GPU e foi benchmarkada no
computador de teste com aproximadamente 45 ms para um recorte em cache e cerca
de 200 ms para seis recortes em lote.

O ML ainda é diagnóstico: seus grupos não autorizam um clique por si só. A
próxima validação deve comparar os grupos com a máscara de pixels visíveis de
cada camada; um crop que mistura carta superior e inferior não deve ser aceito
como classificação da carta inferior.

## Recortes visíveis para cartas cobertas

Na captura de referência `/tmp/tile-rescue-layer-reference-01/reference.png`,
a inspeção manual encontrou seis cartas jogáveis e várias cartas parcialmente
visíveis. O primeiro grafo geométrico gerou 34 hipóteses, das quais 27 eram
possíveis cartas ocultas, mas o contact sheet mostrou falsos positivos e
recortes dominados pela carta de cima ou pelo fundo verde.

Foi implementada uma segunda representação para cada hipótese com relação
`likely-covers`: além de `crops/`, o pacote agora pode conter
`visible/<id>.png`. Nesse recorte a interseção da carta superior estimada é
mascarada com a cor do tabuleiro. O recorte bruto continua sendo preservado e
`visible-contact-sheet.png` permite comparar os dois. O `local_ml.js` usa o
recorte mascarado para cartas ocultas, mas ainda não transforma uma hipótese
geométrica em verdade: localização, máscara e agrupamento precisam ser
validados em capturas antes de autorizar jogadas.

Na mesma referência, o encoder local agrupou corretamente os dois blueberries
visíveis entre si e os dois bolos visíveis entre si. Isso valida o mecanismo de
similaridade para ícones do nível, mas não prova ainda a identidade das cartas
ocultas; essa é a próxima etapa de avaliação dos recortes mascarados.

### Próxima validação autorizada

O pacote passou a gerar `layer-graph-overlay.png`, uma sobreposição visual com
cartas disponíveis, hipóteses ocultas e arestas de cobertura. A validação deve
usar essa imagem para separar erro de localização (grafo) de erro de identidade
(ML). Nenhuma dessas hipóteses deve ser enviada ao planejador de cliques antes
de reduzir os falsos candidatos na sobreposição.

Na primeira inspeção do overlay, foram encontrados candidatos no fundo abaixo
da camada inferior do tabuleiro. O limite inferior do ROI foi reduzido de
`y=1450` para `y=1260`: a camada real observada termina perto de `y=1170`, e
isso remove a faixa espúria sem excluir as cartas reais da referência.

Também foi corrigida a densidade do grafo. Arestas para pontos duplicados de
cartas já disponíveis foram descartadas; relações com interseção menor que
12% ou confiança menor que 0,35 foram rejeitadas; e cada alvo oculto mantém no
máximo as duas coberturas mais fortes. Assim a validação passa a avaliar
relações concretas, em vez de uma malha de sobreposições especulativas.

Cada pacote agora inclui `layer-graph-validation.json`. Na captura atual, o
relatório valida todas as arestas contra as regras do grafo, informa o máximo
de duas arestas por alvo e separa alvos ocultos com e sem cobertura candidata.
Na validação da tela atual, foram encontradas 24 hipóteses ocultas e 45 arestas;
as 24 receberam pelo menos uma cobertura candidata, o máximo por alvo foi 2,
com interseção mínima de 0,166 e confiança mínima de 0,404.

## 2026-09-20 — grupos desconhecidos entram no planejamento com segurança

Na terceira abertura do nível 23, os ícones mudaram novamente. A captura
`/tmp/tile-rescue-dry-run-20260920` mostrou quatro cartões marrons livres,
visualmente iguais, e dois sóis livres. O classificador não confirmou um nome:
os quatro ficaram `unknown`, com alternativa `cake` entre 0,82 e 0,84, mas o
agrupamento local foi consistente como `unlabeled-group-1`.

O diagnóstico mostrou a causa da decisão errada: `chooseAction()` só indexava
`tile.type` conhecido, então ignorava o grupo marrom e escolhia o par de sóis.
Foi implementada a separação entre `type`, `sessionGroupId` e `planningKey`.
Grupos desconhecidos são considerados somente com pelo menos duas ocorrências
jogáveis e uma oportunidade de três cartas no total; um singleton desconhecido
continua fora da exploração. O grupo marrom agora deve produzir
`start-exposed-triple` sem depender de um nome humano.

Também foram desativadas as heurísticas de cor que chamavam automaticamente
tons verdes de `corn` ou `carrot`, pois o nível atual contém pimentões verdes.
O limiar de referência `0.88` foi mantido. Cada pacote passa a salvar
`phase-map.json`, incluindo membros, papéis, chaves de planejamento e
evidência de contagem.

As duas cartas livres marrons da captura de referência já foram cadastradas
como `pudding`. `pepper` ainda aguarda uma carta verde livre e limpa para não
transformar um recorte parcialmente coberto em referência persistente. Isso
melhora a auditabilidade e os nomes exibidos, mas não é pré-requisito para
formar trincas com segurança visual.

### Validação desta implementação

As verificações `node --check` passaram para `agent.js`, `vision.js`,
`local_ml.js` e `play.js`. O replay dos arquivos em
`/tmp/tile-rescue-dry-run-20260920` retornou `start-exposed-triple` para
`unlabeled-group-1`, e o dry-run atual com as referências de `pudding` retornou
`start-exposed-triple` para `pudding`. O dry-run `--no-ml` também encontrou
`visual-group-1` com quatro cartas e retornou a mesma prioridade.

`npm test` continua interrompido pela ausência do primeiro fixture histórico,
`/tmp/tile_rescue_level23_clean.png`; os demais caminhos não foram declarados
com falha de código por causa disso. Os outros caminhos ausentes já listados no
handoff permanecem: `/tmp/agent_after_one.png`, `/tmp/agent_after_two.png`,
`/tmp/tile-rescue-after-two.png` e `/tmp/tile_rescue_manual_carrot_check.png`.

### Primeiro teste ao vivo controlado

Com autorização explícita, foi executada exatamente uma jogada em
`/tmp/tile-rescue-live-test-20260920`, no ponto `(539,715)`. A decisão antes
do toque foi `start-exposed-triple` para `pudding`, com quatro cartas livres.
O runner registrou um movimento executado e não continuou.

A captura posterior foi analisada em
`/tmp/tile-rescue-after-live-test-20260920`: a carta apareceu corretamente na
bandeja como `pudding`, e a próxima decisão foi
`complete-triple-potential`, com três pudins ainda disponíveis. Nenhuma
segunda jogada foi executada.

### Segundo movimento ao vivo controlado

Com nova autorização, foi executada uma segunda jogada em
`/tmp/tile-rescue-live-test-20260920-move2`, no ponto `(682,715)`. A decisão
antes do toque foi `complete-triple-potential` para `pudding`.

Após a animação, a análise em
`/tmp/tile-rescue-after-live-test-20260920-move2` encontrou dois `pudding` na
bandeja e três cópias disponíveis. A próxima recomendação é
`complete-triple` no ponto `(754,785)`. O terceiro movimento não foi executado.

### Terceiro movimento ao vivo controlado

Com nova autorização, foi executada a terceira jogada em
`/tmp/tile-rescue-live-test-20260920-move3`, no ponto `(754,785)`. A decisão
foi `complete-triple` para `pudding`.

A análise posterior em
`/tmp/tile-rescue-after-live-test-20260920-move3` confirmou a remoção da
trinca: a bandeja voltou a ficar vazia. O tabuleiro agora apresenta duas
cartas `cake` livres, e a próxima recomendação é `start-exposed-pair` para
`cake`. Nenhuma quarta jogada foi executada.

### Diagnóstico de cupcake versus bolo

Na análise pós-terceira jogada, a recomendação classificou como `cake` duas
cartas que visualmente são diferentes: o recorte em `(611,645)` é um cupcake,
enquanto o recorte em `(825,864)` é um bolo fatiado. A inspeção confirmou que
as duas referências atuais em `icon-library/cake/` são bolos fatiados e que
não existe ainda uma referência de `cupcake`.

O dry-run `--no-ml` identificou `(611,645)` como `cupcake` pela heurística
legada e manteve `(825,864)` como grupo visual desconhecido. Portanto, o
planejador não causou a confusão: o classificador local aplicou `cake` ao
cupcake com confiança 0,9165 e sobrescreveu a semântica legada correta.

Nenhuma carta foi tocada depois dessa descoberta. A correção foi aplicada:
foi cadastrada uma referência limpa de `cupcake` a partir de `(611,645)`, duas
referências limpas de `pepper` a partir de `(754,644)` e `(611,785)`, e o
aplicador de rótulos passou a preservar uma semântica legada conflitante,
registrando o rótulo ML em `modelConflict` para auditoria.

### Correção validada — cupcake, bolo e pimentão

Foram adicionadas referências limpas para `cupcake` e `pepper`. O aplicador
agora preserva uma semântica legada quando um rótulo nomeado do ML entra em
conflito, mas mantém o rótulo e a confiança do modelo em `modelConflict`.

No dry-run posterior, a classificação ficou:

- `(611,645)`: `cupcake`, confiança 0,9904;
- `(825,864)`: `cake`, confiança 0,9818;
- `(754,644)` e `(611,785)`: `pepper`, confiança acima de 0,988.

A recomendação passou a ser `start-exposed-pair` para `pepper`, sem misturar
cupcake com bolo. Nenhuma jogada ao vivo foi executada após a correção.

### Desempate geométrico do grafo

A captura com dois `pepper` e dois `pudding` mostrou que o grafo já possuía
26 alvos ocultos e 49 arestas, mas `chooseAction()` não consultava essas
relações no empate. Foi adicionado um desempate geométrico: dentro do grupo
escolhido, a carta que cobre mais alvos ocultos recebe prioridade.

O planejador não usa a quantidade bruta de arestas para afirmar que um alvo
oculto é do mesmo ícone. Essa identidade só conta quando o alvo foi confirmado;
caso contrário, a aresta serve apenas como potencial de liberação. No pacote
salvo, o grupo escolhido continua sendo `pepper`, e a carta selecionada passa
a ser `(611,785)`, que cobre três alvos geométricos.

### Quarto movimento ao vivo controlado

Antes do toque, o dry-run confirmou `start-exposed-pair` para `pepper` e
selecionou `(611,785)` pelo desempate geométrico. Com autorização, essa quarta
jogada foi executada em `/tmp/tile-rescue-live-test-20260920-move4`.

A análise posterior em
`/tmp/tile-rescue-after-live-test-20260920-move4` encontrou um `pepper` na
bandeja e outro `pepper` livre em `(754,644)`, além de uma segunda cópia já
presente na bandeja. A próxima recomendação é
`complete-triple-potential`. Nenhum quinto movimento foi executado.

### Quinto e sexto movimentos ao vivo controlados

Após o dry-run confirmar `complete-triple-potential` para `pepper`, foram
executados exatamente dois movimentos autorizados em
`/tmp/tile-rescue-live-test-20260920-moves5-6`:

1. `(682,855)`, completando a segunda cópia de `pepper` na bandeja;
2. `(754,644)`, completando a trinca de `pepper`.

A análise posterior em `/tmp/tile-rescue-after-live-test-20260920-moves5-6`
confirmou a remoção da trinca e a bandeja vazia. Três `pudding` ficaram livres,
e a próxima recomendação é `start-exposed-triple` para `pudding`. Nenhum
sétimo movimento foi executado.

### Sétimo, oitavo e nono movimentos ao vivo controlados

Com autorização, foram executados exatamente três movimentos em
`/tmp/tile-rescue-live-test-20260920-moves7-9`:

1. `(825,583)`, iniciando a trinca de `pudding`;
2. `(540,1177)`, formando o par na bandeja;
3. `(326,1177)`, completando a trinca.

A análise posterior em `/tmp/tile-rescue-after-live-test-20260920-moves7-9`
confirmou a remoção da trinca e a bandeja vazia. O tabuleiro agora tem dois
`cake` e dois `cupcake` livres; a próxima recomendação é
`start-exposed-pair` para `cake`. Nenhum décimo movimento foi executado.

### Diagnóstico: cupcake coberto não entra na trinca

Na captura pós-movimentos 7–9, a inspeção visual mostrou um `cupcake`
disponível cobrindo outro `cupcake` logo abaixo/ao lado. O grafo geométrico
registrou essa relação: uma cobertura próxima de `(611,644)` aponta para um
alvo em torno de `(690,645)`, com sobreposição 0,526 e confiança 0,99.

O problema está na identidade, não na localização. O alvo do grafo permaneceu
`unknown`, então o planejador contou somente os dois `cupcake` já livres e
acabou priorizando o par de `cake`. A carta oculta não deve ser clicável, mas
seu grupo visual provável precisa ser associado à ação de liberar o alvo.

Próxima correção: transportar a evidência de grupo entre cartas disponíveis e
alvos cobertos, mantendo o alvo como `hidden` e usando essa informação somente
para priorizar a carta superior que o libera.

### Hipótese refinada: classificação de cartas inferiores

A inspeção visual do pacote `/tmp/tile-rescue-after-live-test-20260920-moves7-9`
confirmou que o grafo encontrou o alvo em `(690,645)` e a cobertura a partir de
`(611,644)`. O erro semântico não veio de um clique ou de uma troca de ícone:
o recorte bruto da carta inferior contém pixels da carta superior, enquanto o
recorte mascarado deixa somente uma faixa parcial do ícone inferior. Para o
modelo, isso não é comparável diretamente com uma referência completa de
`cupcake`; a maior correspondência ficou em `0.772` para `pepper`, abaixo do
limiar nomeado `0.88`.

A hipótese de trabalho é que cartas inferiores precisam de referências
parciais geradas com a mesma máscara geométrica do alvo. A máscara deve ser
aplicada somente à interseção estimada da carta superior com a caixa do alvo;
o recorte bruto continua salvo para auditoria, mas não participa da decisão
semântica de uma carta `hidden`. Assim evitamos identificar o ícone da carta de
cima no lugar do ícone de baixo.

Implementação inicial: o classificador passa a gerar variantes mascaradas das
referências nomeadas em `reference-variants/` e compara a versão visível do
alvo com a referência recortada pela mesma geometria. O manifesto também salva
`visibleMask.maskedRects`, `maskedFraction` e `remainingFraction`, permitindo
verificar se a hipótese está realmente classificando uma área suficiente. A
carta inferior permanece `hidden` e nunca autoriza toque direto; esta etapa
melhora somente a identificação visual. Para uma correspondência parcial, a
implementação usa um limiar próprio de `0.80`, visibilidade mínima de `0.45`,
margem mínima de `0.01` sobre a segunda classe e pelo menos duas cópias completas
confirmadas do mesmo rótulo no nível. O limiar global de `0.88` para cartas
completas não foi reduzido. Cada aceitação parcial registra essa evidência no
JSON e ainda precisa ser validada em replays com diferentes posições e
percentuais de oclusão antes de alterar o planejador.

Para escolher a cobertura de um alvo, o classificador agora gera uma variante
por `cover` candidato e registra `coverCandidates` no JSON. Quando duas máscaras
produzem o mesmo rótulo, a maior margem sobre a segunda classe vence; quando os
rótulos divergem, a maior confiança continua vencendo. Um cover forte (`>=0,90`)
permite margem parcial de `0,005`; covers geométricos fracos continuam exigindo
`0,01`. Essa exceção é local à carta parcialmente coberta e não reduz o limiar
global de cartas completas.

### Correção final do vínculo entre classificação e grafo

O replay alinhado confirmou que o alvo `(690,645)` era reconhecido como
`cupcake` (`0,8806`), mas a recomendação ainda escolhia `cake`. A causa era
uma cópia independente do alvo dentro de `layerGraph.edges`: o rótulo era
aplicado ao nó oculto, mas a aresta continuava com `target.type` vazio.

`applyVisionLabels()` agora sincroniza identidade, grupo, confiança e origem
entre os nós classificados e as cópias de `cover`/`target` nas arestas dos
grafos. Assim, o score de liberação pode reconhecer que uma carta disponível
libera uma cópia do mesmo cupcake. Foi adicionado um teste de regressão com
dois cupcakes, dois bolos e um cupcake oculto; a ação esperada é o grupo de
cupcake, sem tocar diretamente no alvo oculto.

### Três movimentos reais após a correção de cobertura

Com autorização explícita, o runner executou exatamente três movimentos em
`/tmp/tile-rescue-live-corrected-20260920-moves3`:

1. `(611,644)`, recomendado como `start-exposed-pair` para `cupcake`;
2. `(682,574)`, recomendado como `complete-triple-potential` para `cupcake`;
3. `(325,1158)`, recomendado como `complete-triple` para `cupcake`.

A captura `move-002-after/after.png` mostra a bandeja vazia após a remoção da
trinca e o tabuleiro permaneceu aberto. As três decisões e capturas antes/depois
foram preservadas para auditoria; nenhum movimento adicional foi executado.

### Três movimentos reais — sequência dos sóis

Com nova autorização, foram executados exatamente três movimentos em
`/tmp/tile-rescue-live-suns-20260920-moves3`:

1. `(397,715)`, `start-exposed-pair` para `sun`;
2. `(754,1168)`, `make-pair-with-tray` para `sun`;
3. `(325,645)`, `search-hidden-match` para `pepper`, pois o par de sóis ficou
   na bandeja sem uma cópia de sol disponível diretamente.

A terceira decisão foi uma exploração controlada autorizada, não a conclusão
da trinca. A bandeja ficou com dois sóis após a captura de `move-002-before`;
o próximo estado deve ser analisado antes de qualquer novo toque.

### Diagnóstico da terceira jogada dos sóis

A captura `move-002-before` mostrou que a visão estava correta: havia três
`cupcake` livres em `(325,785)`, `(325,1147)` e `(754,1158)`, com confianças
ML entre `0,969` e `0,976`. A bandeja continha dois `sun` e o estado registrava
`visibleCounts.cupcake = 3`.

A falha foi do planejador. Em `chooseAction()`, o ramo de `blockedGroups`
(`sun` representado duas vezes na bandeja) é executado antes de
`exposedGroups`. Como não encontrou uma terceira carta `sun` diretamente, o
fallback `search-hidden-match` pontuou todas as cartas disponíveis por uma
heurística de cartas abaixo e escolheu o `pepper` em `(325,645)`. Essa busca
não exigia que o tile escolhido pertencesse a uma trinca exposta segura.

Conclusão: não foi falha de captura nem de identificação; foi prioridade
incorreta do planejador. Uma trinca exposta confirmada deve vencer a exploração
de uma carta escondida para completar um par da bandeja, especialmente quando
a exploração não tem uma aresta forte para um `sun` oculto.

### Correção da prioridade: trinca exposta versus exploração

`chooseAction()` foi ajustado para preservar a busca direta por uma terceira
carta do par da bandeja quando existe uma aresta forte e uma carta de cover
disponível. Porém, se essa liberação direta não existe, uma trinca exposta
confirmada agora vence o fallback `search-hidden-match`. O replay da captura
problemática passou a retornar `start-exposed-triple` para `cupcake` em vez de
escolher `pepper`. Foi adicionado um teste de regressão com dois `sun` na
bandeja, três `cupcake` livres e um `pepper` exploratório.

### Correção geométrica do recorte da carta inferior

A inspeção de `/tmp/tile-rescue-after-live-test-20260920-moves7-9/move-000-before/vision/visible/hidden-7-690-645.png` e da referência visual fornecida mostrou que o recorte anterior era uma caixa `144×144`, enquanto a carta detectada mede `142×160`. Além de cortar as bordas superior/inferior, isso deslocava a máscara em relação à face arredondada da carta e deixava pixels da carta superior no recorte da inferior.

O contrato foi corrigido para usar o retângulo alinhado `142×160` da própria carta. A máscara agora usa o mesmo sistema de coordenadas e referências antigas quadradas recebem a máscara redimensionada proporcionalmente. O recorte bruto continua sendo salvo para auditoria; o classificador deve consumir somente a face alinhada e mascarada. A validação visual de um novo pacote é obrigatória antes de confiar novamente nas pontuações semânticas.

### Prioridade entre trinca potencial, trinca exposta e par

O dry-run após a execução do `cake` mostrou um estado com dois `sun` na
bandeja sem `sun` livre, um `pepper` na bandeja com apenas um `pepper` livre,
um `cupcake` na bandeja com dois `cupcake` livres e três `pudding` livres.
O planejador escolheu `pudding` porque o ramo de par bloqueado dos sóis era
avaliado antes da trinca potencial de cupcakes.

A regra foi refinada e coberta por testes: primeiro completar uma trinca já
representada uma vez na bandeja com duas cópias livres; depois começar uma
trinca de três cartas livres, desde que existam três posições vazias; só então
estender um par como `pepper`. Assim, a trinca garantida de `cupcake` vence o
par de `pepper`, e a trinca de `pudding` vence o par quando houver espaço
suficiente. Nenhuma trinca exposta é iniciada se os três toques não couberem
com segurança na bandeja de sete posições.

### Preparação do nível 24 — novos ícones

O tabuleiro do nível 24 foi capturado sem toque em
`/tmp/tile-rescue-level24-current.png` e analisado em
`/tmp/tile-rescue-level24-dry-20260920`. Foram observados dois ícones novos:

- morango, cadastrado como `strawberry` com quatro referências limpas dos
  recortes `(200,792)`, `(336,792)`, `(744,792)` e `(610,930)`;
- fruta laranja, visualmente um pêssego e não uma manga, cadastrado como
  `peach` com uma referência limpa e dois recortes alinhados adicionais.

Após o cadastro, os quatro morangos livres foram reconhecidos como
`strawberry` com confiança entre 0,9854 e 0,9910. As ocorrências parcialmente
cobertas da fruta laranja passaram a receber evidência `peach`; as cartas
inferiores continuam não clicáveis até serem liberadas pelo grafo. Nenhum
movimento do nível 24 foi executado.

### Conclusão do nível 23

Após a correção de prioridade, foram executados nove movimentos reais pelo
runner em `/tmp/tile-rescue-live-next9-20260920`, sem intervenção manual:

1. três `cake`, removendo a trinca;
2. três `pudding`, removendo a trinca;
3. três `sun`, removendo a trinca.

O `run.json` registrou `executedMoves: 9` e conclusão normal. A nível 23 foi
completada com sucesso. A sequência confirma o fluxo final do planejador:
trinca exposta, trinca potencial com uma peça na bandeja e conclusão da
trinca, sempre reanalisando o estado entre os toques.

### Nota operacional sobre execuções longas

Em uma execução anterior de múltiplos movimentos, o terminal expirou antes de
mostrar a saída, embora o processo do runner continuasse ativo e o
`run.json` ainda estivesse sendo atualizado. Uma repetição manual de uma
coordenada antiga ocorreu antes de essa situação ser percebida; como o
tabuleiro já havia mudado, a coordenada atingiu outra carta. A regra operacional
fica registrada: em execuções ao vivo, nunca repetir coordenadas; aguardar o
processo terminar e consultar `run.json` e as capturas `move-XXX-before`.

### Detecção explícita de conclusão do nível

O runner passou a verificar, após cada toque, a condição de tabuleiro limpo:
`available=0`, `hidden=0`, `tray=0` e nenhum componente detectado. Quando essa
condição ocorre, o `run.json` registra `completed: true` e
`completionReason: "empty-board"`, e `after.json` recebe a mesma evidência.

Paradas por `safety-stop` ou ausência de ação agora ficam separadas em
`stopReason`, evitando confundir uma parada segura com a conclusão do nível.
Isso permite rodar com um limite alto de movimentos e encerrar assim que o
tabuleiro for realmente limpo.

Para evitar falso positivo em tela bloqueada, carregamento ou tela preta, a
condição de conclusão também exige que a captura apresente o fundo teal do
tabuleiro em pontos de referência do cabeçalho. A tela do aparelho foi
encontrada bloqueada durante a preparação do nível 24; nenhuma execução ao
vivo foi iniciada nesse estado.

### Desempenho observado no runner do nível 24

Durante a execução real com `--moves 999`, o campo `mlSummary.inferenceMs`
registrou aproximadamente 20,6–28,1 segundos por captura. O intervalo total
entre capturas ficou em aproximadamente 30–36 segundos. O `settleMs` configurado
é de apenas 1,2 segundo, portanto a inferência do modelo local em CPU é o
principal consumidor conhecido.

O runner ainda não mede separadamente captura, geração do pacote de visão,
gravação dos artefatos, chamada ADB, espera pós-toque e `chooseAction()`. Depois
da conclusão do nível 24, adicionar esses tempos por movimento e otimizar a
inferência sem reduzir os critérios de segurança será a próxima melhoria
prioritária.

### Falso positivo de conclusão no nível 24 e correção do ROI

O primeiro teste com `--moves 999` encerrou após 24 toques com
`completed: true`, mas a captura `move-023-after/after.png` ainda mostrava
três cartas na parte inferior. A análise manual confirmou que elas ocupavam
aproximadamente `y=1292..1423`, fora do ROI antigo que terminava em `y=1260`.

O `BOARD_ROI` foi ampliado para `y=1480`, ainda antes da bandeja, e a captura
final será reanalisada antes de qualquer continuação. O nível 24 não deve ser
considerado concluído pelo primeiro `run.json`; o motivo foi um falso positivo
de detecção, não uma vitória real.

Além de `available`, `hidden` e `tray`, a detecção agora exige
`detected=0`. O replay da captura final passou a encontrar 3 cartas disponíveis
em `y=1367` e 9 relações ocultas com o ROI corrigido.

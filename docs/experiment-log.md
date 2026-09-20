# Diário de experimentos

## Estado inicial

- Dispositivo de teste: Samsung conectado por ADB.
- Resolução observada: `1080x2340`.
- Região útil do tabuleiro: entre o header e a bandeja, aproximadamente
  `x=20..1060`, `y=430..1260`.
- A bandeja ocupa uma região separada e tem sete posições sobrepostas.
- O objetivo operacional é completar a fase; a contagem de sóis não é uma
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

## Ícones variáveis por fase

Foi observado que ao sair e voltar para o jogo o conjunto de ícones pode mudar.
Isso invalida uma política baseada apenas em nomes e limiares de cor fixos. A
geometria do tabuleiro continua reutilizável, mas a identidade das peças deve
ser criada por fase.

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
dispositivo, fase, modo, modelo, quantidade de referências e movimentos
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
variações entre fases. O encoder calcula embeddings dessas referências e
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
fase. A implementação não usa API remota, não exige GPU e foi benchmarkada no
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
similaridade para ícones da fase, mas não prova ainda a identidade das cartas
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

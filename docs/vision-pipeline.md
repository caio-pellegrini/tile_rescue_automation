# Pipeline de visão

## O que existe hoje

O agente combina visão geométrica local com um classificador local opcional. Ele
captura a tela via ADB, recorta a região do tabuleiro, procura as faces claras
das cartas, calcula assinaturas de cores e mantém um grafo de oclusão. O
`play.js` pode complementar essa leitura com embeddings locais do catálogo
nomeado, sem enviar imagens para fora da máquina.

Isso é rápido e barato, mas tem uma limitação importante: quando um ícone está
parcialmente coberto, as cores visíveis podem parecer pertencer a outro ícone.
Foi exatamente o que aconteceu com os cupcakes que foram classificados como
milho.

## Pacote de visão implementado

O comando abaixo captura a tela e exporta um pacote sem tocar no dispositivo:

```bash
VISION_PACKET_DIR=/tmp/tile-rescue-vision node agent.js --export-vision
```

O pacote contém `screen.png`, recortes quadrados em `crops/`, um
`contact-sheet.png` e um `manifest.json` com coordenadas, tipo estimado pelo
agente, distância da assinatura, visibilidade, referências da bandeja e
relações do grafo. As cartas `hidden` inferidas pelo grafo também entram no
pacote para que o modelo possa analisar o que está parcialmente visível.

Quando existe uma aresta `likely-covers`, o pacote também grava
`visible/<id>.png`: é o mesmo quadrado, mas com a interseção da carta superior
estimada mascarada. O recorte original continua em `crops/` e a comparação
fica disponível em `visible-contact-sheet.png`. Essa separação é necessária
para não classificar a carta de cima como se fosse a carta escondida.

Se houver mais de uma aresta candidata para o mesmo alvo, o pacote grava também
`visible/<id>--cover-*.png`, uma imagem por hipótese de carta superior. O modelo
compara cada variante com referências mascaradas pela mesma geometria e registra
`coverCandidates`; não deve misturar duas cartas superiores numa única mancha.

O mesmo pacote grava `layer-graph-overlay.png`. Nesse diagnóstico, `A` marca
cartas disponíveis, `H` marca hipóteses ocultas e as linhas vermelhas mostram
relações `likely-covers`. Ele serve para calibrar a geometria; não é uma
autorização para clicar. Uma relação só entra no overlay se o alvo for uma
hipótese oculta, houver pelo menos 12% de interseção estimada, confiança mínima
de 0,35 e ela estiver entre as duas melhores coberturas daquele alvo. O arquivo
`layer-graph-validation.json` registra essas verificações e informa quantos
alvos ficaram sem cobertura candidata.

O recorte usa o retângulo geométrico real da carta, `142×160` pixels, alinhado
às bordas estimadas em vez de um quadrado `144×144` ao redor do centro. Portanto ele
continua podendo mostrar apenas uma fração do ícone de uma carta bloqueada;
isso é desejado, pois o classificador precisa retornar também a confiança e as
alternativas possíveis.

## Contrato para um classificador visual

Para cada item de `manifest.tiles`, um classificador pode devolver:

```json
{
  "id": "board-3-540-790",
  "label": "cupcake",
  "confidence": 0.91,
  "alternatives": [
    { "label": "corn", "confidence": 0.07 }
  ],
  "visibleFraction": 0.42
}
```

O classificador deve identificar o ícone; ele não deve decidir sozinho qual
peça tocar. A ordem de jogada continua sendo responsabilidade do planejador,
que combina a identificação com a posição, a bandeja e as dependências de
oclusão.

## Estratégia de custo

1. Usar a visão local para localizar cartões e o grafo para estimar cobertura.
2. Comparar os recortes com referências nomeadas conhecidas.
3. Fazer uma inferência em lote por estado, em vez de uma chamada por cartão.
4. Carregar o encoder e os embeddings das referências uma única vez por
   execução; o runner reaproveita esses recursos entre movimentos.
5. Depois de um toque, usar a captura `after` como a próxima observação, sem
   repetir uma captura intermediária desnecessária.

O projeto agora inclui `local_ml.js`, que usa um encoder visual local quantizado
em CPU para gerar embeddings dos recortes. As referências nomeadas ficam em
`icon-library/catalog.json`, com imagens agrupadas por nome em inglês. O modelo
compara cada recorte com cada exemplar dessas referências e retorna, por exemplo,
`blueberry`, `butterfly` ou `cake`. Ícones sem correspondência suficiente ficam
como `unknown`; grupos internos de desconhecidos existem apenas para diagnóstico
e nunca substituem um nome confirmado.

Para cadastrar uma referência a partir de um recorte já exportado:

```bash
node local_ml.js --add-reference /tmp/tile-rescue-vision board-0-397-715 blueberry
```

Uma imagem isolada também pode ser cadastrada com uma variante explícita:

```bash
node local_ml.js --add-image /tmp/sun0.png sun collectible
node local_ml.js --add-image /tmp/sun1.png sun partial
```

As variantes `normal`, `partial` e `collectible` continuam pertencendo ao
mesmo rótulo lógico `sun`, mas não são misturadas em um protótipo médio.

Depois, a classificação normal continua sendo:

```bash
node local_ml.js /tmp/tile-rescue-vision
```

O comando recebe o pacote em lote e grava `local-predictions.json`; não envia
imagens para fora da máquina. O `play.js` chama a mesma biblioteca durante a
rodada, mas mantém o modelo carregado em memória.

O resultado local pode ser aplicado antes do planejador:

```bash
VISION_LABELS_FILE=/tmp/tile-rescue-vision/local-predictions.json node agent.js
```

Um exemplo está em [`examples/vision-labels.json`](../examples/vision-labels.json).

Quando uma referência é reconhecida, o `groupId` interno é o próprio nome
canônico (`blueberry`, por exemplo), e esse é também o tipo consumido pelo
planejador. Para imagens não cadastradas, o `groupId` técnico é isolado do
rótulo humano `unknown`, evitando que `visual-group-1` apareça como se fosse o
nome de uma peça.

O backend é Transformers.js sobre ONNX Runtime em CPU, com o modelo
`Xenova/clip-vit-base-patch32` quantizado por padrão. O modelo é baixado uma vez
e mantido em cache local; depois, a inferência ocorre na máquina.

Só são aceitos rótulos com confiança mínima de `0.75` por padrão; o valor pode
ser ajustado com `VISION_MIN_CONFIDENCE`. Assim, uma classificação incerta não
substitui silenciosamente a visão local.

## Limites conhecidos

- A localização de cartas parcialmente cobertas ainda depende do detector
  geométrico; um recorte errado não pode ser corrigido apenas por classificação.
- O ROI do tabuleiro foi delimitado até `y=1260` para o layout atual do
  dispositivo, mantendo a camada inferior observada em torno de `y=1170` e
  excluindo o fundo abaixo dela. Se a resolução ou escala do dispositivo mudar,
  esse limite deve ser recalibrado.
- O classificador local atual usa embeddings visuais de CLIP quantizado em CPU;
  isso ajuda a agrupar ícones novos, mas não é uma segmentação perfeita de
  cartas parcialmente cobertas.
- O grafo pode propor uma relação falsa quando duas cartas se sobrepõem pouco;
  por isso a confiança e o limiar de segurança devem ser mantidos.
- A máscara usa a interseção dos retângulos alinhados das cartas; bordas
  arredondadas, sombras e falsos candidatos ainda precisam de validação visual.
- Antes de habilitar qualquer classificador remoto, é necessário definir o
  tratamento das capturas e testar o custo/latência no dispositivo físico.

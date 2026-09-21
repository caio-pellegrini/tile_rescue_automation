# Tile Rescue automation

Agente local para o Tile Rescue via ADB. Ele captura a tela, detecta as peças expostas e os slots da bandeja, agrupa os ícones por assinatura visual e escolhe uma ação conservadora.

## Uso

```bash
npm install
npm test
node play.js --dry-run        # captura e recomenda, não toca na tela
node play.js --live --moves 1 # executa somente depois de revisar a recomendação
node play.js --dry-run --fast # caminho rápido, sem auditoria visual completa
node play.js --dry-run --fast --raw-capture # experimento: captura RGBA sem PNG
node agent.js                 # entrada legada/diagnóstico
VISION_PACKET_DIR=/tmp/tile-rescue-vision node agent.js --export-vision
node local_ml.js /tmp/tile-rescue-vision
VISION_LABELS_FILE=/tmp/tile-rescue-vision/local-predictions.json node agent.js
node local_ml.js --add-reference /tmp/tile-rescue-vision board-0-397-715 blueberry
```

O `play.js` é o runner principal. Ele carrega o encoder local uma vez por
execução, reutiliza as referências nomeadas, espera a animação terminar após
cada toque e nunca usa moedas, anúncios ou os botões de reforço. O padrão é
dry-run e o limite padrão é um movimento; aumente `--moves` somente depois de
revisar a recomendação.

O modo completo classifica também hipóteses ocultas e grava todos os artefatos
de auditoria. `--fast` classifica somente cartas disponíveis e da bandeja,
mantém a proteção contra cartas ocultas e omite overlays/contact sheets. Use
`--replay-dir /tmp/execucao-anterior` para reprocessar capturas existentes sem
ADB. Os tempos detalhados de cada movimento ficam em `timing.json`.
Em uma execução rápida com mais de um movimento, a checagem geométrica
duplicada pós-toque é adiada para a análise seguinte da mesma captura; no
último movimento permitido ela continua imediata para preservar a detecção de
conclusão.
`--raw-capture` é experimental e só altera a captura ADB; o padrão continua
PNG para preservar o caminho já auditado. O modo bruto valida o cabeçalho e o
payload RGBA antes de entregar a imagem à visão.

## Estratégia

- completa trincas já formadas na bandeja;
- prioriza uma peça que tenha uma cópia na bandeja e duas cópias expostas no
  tabuleiro (`complete-triple-potential`);
- quando a bandeja está vazia, prefere três cópias expostas antes de aceitar
  apenas um par;
- se houver um par na bandeja sem terceira peça exposta, entra em modo de busca
  por uma peça escondida antes de iniciar outro grupo;
- estende um grupo da bandeja antes de abrir uma peça sem relação;
- constrói um grafo experimental de oclusão para relacionar uma peça parcial
  com a carta que precisa ser liberada acima dela;
- prefere pares já expostos;
- interrompe antes de ocupar o último espaço quando não há correspondência direta;
- usa o modelo local em lote por estado, sem serviço remoto e sem recarregar o
  encoder a cada movimento.

O tabuleiro é analisado por uma ROI contínua entre o header e a bandeja
(`x=20..1060`, `y=430..1480` na captura `1080x2340`). O detector procura
cartões nessa área, elimina candidatos sobrepostos e usa a bandeja como uma
região separada; ele não depende mais de duas fileiras fixas.

## Pacote de visão e documentação

O modo `--export-vision` gera uma captura, recortes quadrados de cada cartão,
um contact sheet e um `manifest.json`. Isso permite enviar somente os casos
ambíguos a um modelo local, em lote, sem colocar uma inferência em cada
movimento. `local_ml.js` compara embeddings contra a biblioteca nomeada em
`icon-library/catalog.json`. Para cadastrar uma carta nova, use
`--add-reference` uma vez com o nome em inglês; referências adicionais do mesmo
ícone podem ser cadastradas para cobrir variações entre níveis. Ícones abaixo do
limiar ficam como `unknown`, em vez de receber um nome inventado. O agente
continua responsável por geometria, oclusão e decisão de toque.

As descobertas e os resultados dos testes estão em
[`docs/experiment-log.md`](docs/experiment-log.md), e o contrato do pacote em
[`docs/vision-pipeline.md`](docs/vision-pipeline.md).
Para assumir o projeto em outra sessão, comece pelo
[`docs/HANDOFF.md`](docs/HANDOFF.md), que reúne objetivo, histórico, arquitetura,
limitações e sequência recomendada de validação.

Durante uma execução, o runner salva capturas `before` e `after` por movimento
em `/tmp/tile-rescue-runs/level-23/<timestamp>`, além do pacote de visão,
predições locais, estado e ação em JSON. Use `--run-dir /caminho/da/execucao`
para escolher outro diretório. O `after` vira a observação seguinte, evitando
uma captura/análise redundante depois do toque.

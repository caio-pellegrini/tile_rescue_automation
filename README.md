# Tile Rescue automation

Agente local para o Tile Rescue via ADB. Ele captura a tela, detecta as peças expostas e os slots da bandeja, agrupa os ícones por assinatura visual e escolhe uma ação conservadora.

## Uso

```bash
npm install
npm test
node agent.js                 # simulação, não toca na tela
MAX_MOVES=1 node agent.js --live
```

O modo ao vivo espera a animação terminar após cada toque e nunca usa moedas, anúncios ou os botões de reforço. O limite padrão é um toque por execução; aumente `MAX_MOVES` somente depois de revisar o log.

## Estratégia

- completa trincas já formadas na bandeja;
- se houver um par na bandeja sem terceira peça exposta, entra em modo de busca
  por uma peça escondida antes de iniciar outro grupo;
- estende um grupo da bandeja antes de abrir uma peça sem relação;
- prefere pares já expostos;
- interrompe antes de ocupar o último espaço quando não há correspondência direta;
- usa o modelo somente como fallback futuro para ícones ambíguos, em vez de enviar uma imagem a cada movimento.

O tabuleiro é analisado por uma ROI contínua entre o header e a bandeja
(`x=20..1060`, `y=430..1450` na captura `1080x2340`). O detector procura
cartões nessa área, elimina candidatos sobrepostos e usa a bandeja como uma
região separada; ele não depende mais de duas fileiras fixas.

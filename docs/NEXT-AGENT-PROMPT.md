# Prompt de continuidade — Tile Rescue Automation

Você é o próximo agente responsável por continuar o projeto em
`/home/caio/tile_rescue_automation`.

## Objetivo

Reduzir com segurança o intervalo entre movimentos para no máximo 2 segundos,
sem degradar visão, grafo, classificador ou planejador. Não reduzir
globalmente o limiar de confiança `0.88`, não remover a proteção contra cartas
ocultas, não deixar `unknown` sobrescrever rótulo confiável, não remover a
validação da tela teal ou a detecção de conclusão, não clicar em cartas
parcialmente cobertas e preservar a ROI `x=20..1060, y=430..1480` e os slots da
bandeja com passo de 120 px e recortes centralizados.

## Estado e restrições

- Workspace: `/home/caio/tile_rescue_automation`.
- Branch: `main`; não fazer push sem autorização explícita.
- O working tree contém as alterações desta investigação; preserve mudanças
  existentes e inspecione o diff antes de editar.
- Não executar `--live` nem enviar `input tap` sem autorização explícita nesta
  sessão.
- Comece lendo integralmente `docs/HANDOFF.md`, `README.md`,
  `docs/vision-pipeline.md`, `docs/experiment-log.md`, `agent.js`,
  `vision.js`, `local_ml.js`, `play.js` e `test.js`.
- Siga `/home/caio/.codex/RTK.md`: comandos shell devem usar o prefixo `rtk`.

## O que já foi descoberto

1. O caminho completo original no nível 25 levou `36,35 s`, `20,43 s` e
   `19,54 s` nos três primeiros movimentos. O gargalo era ML, especialmente
   reembedding de referências mascaradas para cartas ocultas.
2. O modo `--fast` reutiliza o modelo e referências, mantém o grafo de ocultação
   e todas as salvaguardas, mas omite auditoria visual que não é necessária à
   decisão. No replay do nível 24, marcou média de `0,73 s` por movimento.
3. Um teste autorizado de três movimentos com `--live-fast` no nível 25 está em
   `/tmp/tile-rescue-level25-live-fast-20260920`: ML médio `336 ms`, mas o
   intervalo total médio foi `6,06 s`. A captura ADB média foi `2,60 s`, o
   settle `1,20 s`, e o processamento pós-toque cerca de `2,42 s`.
4. As cenouras inicialmente não estavam no catálogo. Três referências foram
   cadastradas em `icon-library/catalog.json`; o fast runner passou a reconhecer
   o grupo e escolher cenoura em vez de borboleta. Não desfazer esse cadastro.
5. O antigo `npm test` dependia de screenshots temporários em `/tmp`. Isso foi
   corrigido: a suíte obrigatória agora é determinística e não depende dessas
   fixtures. `npm test` imprime `vision/planner tests: ok`.

## Hipótese atual: PNG é o gargalo ADB

O Android está codificando PNG no `screencap -p`. Em medições diretas:

- PNG: aproximadamente `1,65 MB`, `2,30--2,43 s`;
- bruto: aproximadamente `10,1 MB`, `1,12 s`.

Foi criado o experimento `--raw-capture` em `play.js`. Ele usa
`adb exec-out screencap` sem `-p`, exige cabeçalho de 16 bytes e payload RGBA
`width*height*4`, e falha explicitamente se o formato mudar. O caminho PNG
continua sendo o padrão.

Dry-runs no mesmo estado do nível 25:

- `/tmp/tile-rescue-level25-png-capture-20260920`: ADB `2695 ms`, decode
  `90 ms`, decisão cenoura em `(472,1261)`;
- `/tmp/tile-rescue-level25-raw-capture-20260920`: ADB `1378 ms`, parse
  `0,1 ms`, decisão cenoura em `(472,1261)`.

O `totalMoveMs` do primeiro movimento não inclui a captura inicial, que fica
em `timing.capture`; não somar esses números de forma incorreta. A economia
observada é aproximadamente `1,32 s` por captura. Isso é promissor, mas não
prova a meta de menos de 2 segundos no caminho ao vivo: settle e pós-toque
continuam relevantes.

## Próximas ações recomendadas

1. Revisar o diff de `play.js` e testar `parseRawScreencap()` e o caminho PNG.
2. Comparar PNG e RGBA em várias capturas já existentes, verificando dimensões,
   canais, validação teal, ROI, contagem de cartas, grupos, grafo, ação e
   artefatos. Não aceitar somente a igualdade da coordenada.
3. Medir várias capturas consecutivas com `--dry-run --fast --raw-capture` e
   comparar `timing.capture.adbMs` com PNG no mesmo aparelho. Não usar taps.
4. Considerar uma pequena abstração de captura para tornar o modo bruto um
   backend selecionável, mantendo PNG como fallback e preservando o modo
   completo de auditoria.
5. Avaliar o custo do pós-toque: `after capture`, connected components e
   `postTapSummary` são medidos em `timing.json`. Qualquer redução deve
   preservar a detecção de conclusão e a validação de tela pronta.
6. Só propor ou executar um teste `--live-fast --raw-capture` após pedir e
   receber autorização explícita. Se autorizado, limitar o número de
   movimentos e registrar o run-dir; não fazer uma partida completa.
7. Rodar obrigatoriamente:

   ```text
   node --check agent.js
   node --check vision.js
   node --check local_ml.js
   node --check play.js
   npm test
   git diff --check
   ```

Ao concluir, atualizar `docs/HANDOFF.md` e `docs/experiment-log.md` com as
medições, limitações e qualquer decisão sobre tornar RGBA padrão. Não fazer
push.

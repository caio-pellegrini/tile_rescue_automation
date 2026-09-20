# Biblioteca local de ícones

Cada subdiretório representa um nome canônico em inglês (`blueberry`,
`butterfly`, `cake`, etc.). As imagens são referências positivas usadas pelo
ML local; várias imagens podem pertencer ao mesmo nome para cobrir variações
entre fases.

O cadastro é feito a partir de um pacote de visão:

```bash
node local_ml.js --add-reference /tmp/tile-rescue-vision board-0-397-715 blueberry
```

Para registrar uma variação visual sem um pacote, use:

```bash
node local_ml.js --add-image /tmp/sun0.png sun collectible
node local_ml.js --add-image /tmp/sun1.png sun partial
```

As variações continuam com o mesmo rótulo lógico (`sun`), mas são comparadas
como exemplares separados.

O catálogo fica em `catalog.json`. Um recorte que não atingir o limiar de
similaridade não recebe um nome: ele permanece como `unknown`.

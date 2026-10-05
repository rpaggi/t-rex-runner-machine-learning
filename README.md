# T-Rex Runner + Machine Learning

Um bot que joga o dinossauro do Chrome **olhando a tela**, como um jogador: ele captura o canvas, detecta cactos, pterodáctilos e o dino com um modelo **YOLOv8** treinado por mim, e decide em tempo real se pula, abaixa ou continua correndo. Tudo roda no navegador, com TensorFlow.js dentro de um Web Worker.

Melhor marca até agora: **10.500 pontos**, em velocidade máxima.

## Como funciona

```
canvas do jogo ──► imagem ──► Web Worker (YOLOv8 + TensorFlow.js)
      ▲                                  │
      │                                  ▼
   pula / abaixa ◄── decisão ◄── caixas: cacto, dino, ptero
```

1. **Dados:** gravei um vídeo meu jogando, extraí os frames e rotulei no Roboflow em 3 classes (`cacto`, `dino`, `ptero`). Foram 137 imagens de treino, 25 de validação e 9 de teste.
2. **Treino:** YOLOv8n, 30 épocas, imagens de 640×640 (mAP50 de 0,96 na validação), exportado para TensorFlow.js.
3. **Inferência:** o frame vai para um Web Worker, que roda o modelo e faz o pós-processamento (decodifica o tensor `[1, 7, 8400]` e aplica NMS).
4. **Decisão:** as caixas são convertidas para o espaço do jogo, os cactos vizinhos viram um obstáculo só e o bot escolhe a ação pela distância, pelo tipo e pela altura do obstáculo.
5. **Compensação de latência:** a inferência leva algumas centenas de ms, então a decisão roda a cada frame de tela com a última detecção, projetando a posição dos obstáculos pela idade dela e pela velocidade real do jogo.
6. **Aprendizado:** a cada batida o bot descobre se pulou cedo ou tarde e ajusta a antecedência do pulo, guardando o valor no `localStorage`.

## Rodando

Pré-requisito: Node.js.

```bash
npm install
npm start
```

O servidor abre em `http://localhost:8081`. Espere o modelo carregar (o TensorFlow.js vem de um CDN) e aperte **Espaço** para começar. O bot já está ligado.

### Teclas

| Tecla | O que faz |
|---|---|
| `Espaço` | inicia o jogo |
| `B` | liga/desliga o bot (para comparar com você jogando) |
| `P` | pausa e imprime o tensor bruto e as detecções no console |
| `O` | liga/desliga o overlay com as caixas |
| `R` | apaga o que o bot aprendeu |

A cada batida o console mostra a pontuação, uma tabela com as últimas decisões e o ajuste que o bot fez.

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `index.js`, `index.html`, `index.css`, `assets/` | o jogo original (veja os créditos abaixo) |
| `machine-learning/main.js` | captura de frames, decisão, ação no jogo, overlay e aprendizado |
| `machine-learning/worker.js` | carrega o modelo e roda a inferência no Web Worker |
| `machine-learning/model/` | modelo exportado (`model.json`, pesos e `labels.json`) |
| `fine-tunning/` | vídeo, frames e dataset usados no treino |
| `runs/` | resultados do treino (métricas, matriz de confusão) |

## Treinando o seu próprio modelo

Com o dataset no formato YOLOv8 (por exemplo, exportado do Roboflow), usando o [Ultralytics](https://docs.ultralytics.com):

```bash
yolo detect train data=data.yaml model=yolov8n.pt epochs=30 imgsz=640
yolo export model=runs/detect/train/weights/best.pt format=tfjs
```

Copie o resultado da exportação para `machine-learning/model/` e mantenha o `labels.json` na mesma ordem das classes do `data.yaml`.

Um detalhe que custou caro: o canvas do jogo é transparente e o dataset tem fundo branco, então o worker compõe cada frame sobre branco antes de entregar ao modelo. Sem isso, o modelo enxerga um fundo preto e não reconhece o dino.

## Créditos

- **Jogo original:** [wayou/t-rex-runner](https://github.com/wayou/t-rex-runner), o jogo extraído da página de erro offline do Chrome por [@liuwayong](https://github.com/liuwayong) a partir do [código-fonte do Chromium](https://cs.chromium.org/chromium/src/components/neterror/resources/offline.js?q=t-rex+package:%5Echromium$&dr=C&l=7). Este projeto é um fork com a camada de machine learning adicionada em `machine-learning/`. O jogo mantém a licença BSD 3-Clause original (arquivo `LICENSE`).
- **A ideia:** nasceu de uma aula do [Erick Wendel](https://github.com/ErickWendel) na pós-graduação da [UNIPDS](https://unipds.com.br/), no curso de Engenharia de Software com IA Aplicada, em que uma IA joga o DuckHunt-JS.
- **Ferramentas:** [Ultralytics YOLOv8](https://docs.ultralytics.com), [TensorFlow.js](https://www.tensorflow.org/js) e [Roboflow](https://roboflow.com).

<details>
<summary>Outros forks interessantes do projeto original</summary>

Lista mantida do README do projeto original:

- [vianroyal/t-rex-runner](https://github.com/vianroyal/t-rex-runner): [Kumamon runner](http://vianroyal.github.io/t-rex-runner/)
- [xkuga/t-rex-runner](https://github.com/xkuga/t-rex-runner): [Hello KuGou](http://hellokugou.com/)
- [d-nery/t-rex-runner](https://github.com/d-nery/t-rex-runner): [Novas coisas](http://d-nery.github.io/t-rex-runner/)
- [chirag64/t-rex-runner-bot](https://github.com/chirag64/t-rex-runner-bot): [t-rex runner bot](https://chirag64.github.io/t-rex-runner-bot/)
- [19janil/t-rex-runner](https://github.com/19janil/t-rex-runner): [t-rex runner](https://19janil.github.io/t-rex-runner/)
- [enthus1ast/chromeTrip](https://github.com/enthus1ast/chromeTrip): [Chrome Trip by code0](https://code0.itch.io/chrome-trip)
- [zouariste/corona-runner](https://github.com/zouariste/corona-runner): [Corona runner](https://zouariste.github.io/corona-runner/)

</details>

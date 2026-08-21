# Relógio de Aula (ioga)

Relógio digital de ecrã cheio para dares as tuas aulas: **números grandes brancos
em fundo preto, o ecrã nunca se desliga**, com um cronómetro para a aula de 1h30 e
indicações de postura discretas.

É uma única página (`index.html`), **totalmente auto-contida**: não tem fontes,
scripts nem imagens externas — **não faz um único pedido à internet**. Funciona
100% offline. Não depende de nada do resto do repositório.

## O ecrã nunca se desliga (tripla proteção)

Este é o requisito principal, por isso tem três camadas:

1. **Screen Wake Lock** (Android/Chrome) — impede o ecrã de apagar enquanto a app
   está aberta.
2. **Travão de segurança em vídeo** — se o Wake Lock falhar ou for libertado, um
   vídeo minúsculo a tocar mantém o ecrã aceso.
3. **Re-ativação automática** — sempre que voltas à app ou tocas no ecrã, e ainda
   uma verificação a cada 8 segundos.

No canto superior esquerdo tens um indicador: **«Ecrã sempre ligado ✓»** (verde)
confirma que está ativo. Se ficar vermelho, toca uma vez no ecrã. Esse indicador
**nunca desaparece**, mesmo quando escondes os botões.

## Como usar no telemóvel

1. Abre o link da página no **Chrome** do telemóvel.
2. Toca em **Iniciar aula** quando começares (conta 1h30 para trás).
3. **Toca no ecrã** para esconder os botões — fica só o relógio, sem distrações.
   Toca outra vez para os botões voltarem.

### Ter como "app" no ecrã principal
No Chrome: menu **⋮ → «Adicionar ao ecrã principal»**. Fica um ícone como se fosse
uma app e abre em ecrã cheio.

## Botões

- **Iniciar aula** → começa a contagem de 1h30. Depois vira **Pausar / Retomar**.
  Mantém o dedo neste botão ~1 segundo (toque longo) para **reiniciar** a aula.
- **– / +** → ajusta a duração da aula em passos de 5 min (antes de iniciar).
- **Posturas** → mostra/esconde uma linha discreta com o nome da postura; usa as
  setas ‹ › para avançar. A lista está no fim do `index.html` e é fácil de mudar.
- **Ecrã completo** → esconde a barra do browser.

## O ecrã mantém-se ligado?

Sim. Usa a *Screen Wake Lock* do Android/Chrome: enquanto a página estiver aberta
e visível, o ecrã não se apaga. Se o telemóvel tiver poupança de energia muito
agressiva, confirma que o Chrome pode manter o ecrã ligado. Sugestão: liga o
carregador durante a aula.

## Guardar para usar sempre offline

Guarda o ficheiro `index.html` no telemóvel e abre-o a partir dos Ficheiros — não
precisa de rede nenhuma. Ou usa o «Adicionar ao ecrã principal» acima.

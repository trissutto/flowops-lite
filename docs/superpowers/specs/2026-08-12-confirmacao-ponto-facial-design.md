# Confirmação do ponto facial

## Objetivo

Dar uma confirmação inequívoca após cada registro facial e preparar o terminal para a próxima colaboradora sem ação manual.

## Escopo

O comportamento será aplicado às duas interfaces existentes:

- `/minha-loja/ponto`, usada no computador da loja;
- `/minha-loja/ponto-celular`, usada no celular da loja.

As regras de reconhecimento facial, geolocalização, Wi-Fi, ordem automática dos eventos e gravação no backend não serão alteradas.

## Fluxo aprovado

1. A colaboradora escolhe o próprio nome.
2. A câmera é ligada e o rosto é validado.
3. O backend confirma o registro do evento.
4. A câmera é desligada e a seleção de colaboradoras é temporariamente escondida.
5. Uma confirmação exclusiva ocupa a área principal por 2 segundos.
6. A confirmação desaparece e a seleção de colaboradoras volta automaticamente.

Durante os 2 segundos de confirmação, nenhum novo nome pode ser escolhido. Isso evita que a mensagem da colaboradora anterior se misture com a próxima operação.

## Mensagens

Será usado o primeiro nome da colaboradora:

| Evento retornado pelo backend | Mensagem |
| --- | --- |
| `entrada` | `Bom dia, Thiago. Entrada registrada.` |
| `saida_almoco` | `Saída de almoço registrada, Thiago.` |
| `volta_almoco` | `Retorno do almoço registrado, Thiago.` |
| `saida` | `Saída registrada, Thiago.` |

O horário do registro continua visível junto da mensagem. A saudação da entrada seguirá o texto aprovado, “Bom dia”, independentemente do horário em que uma entrada excepcional for registrada.

## Estados de erro

Erros de registro e o aviso de que os quatro pontos do dia já foram registrados continuam com o comportamento atual. Somente uma resposta bem-sucedida inicia a confirmação de 2 segundos.

## Verificação

- Validar as quatro mensagens por tipo de evento.
- Confirmar que a lista não aparece durante a mensagem.
- Confirmar que a câmera desliga após o sucesso.
- Confirmar o retorno automático da lista após 2 segundos.
- Executar as verificações de TypeScript/lint disponíveis para as duas páginas.

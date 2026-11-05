# Alertas, deduplicação e entrega recuperável

Prioridade: **P1**. Status: **concluído localmente em 05/11/2026**.

## Implementação e decisões entregues

| Componente                 | Comportamento entregue                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Máquina de estados         | Os alertas possuem ciclo de vida explícito: `pending`, `in_flight`, `sent`, `expired` e `failed`. O estado `in_flight` é gravado antes da invocação do transporte, prevenindo envio duplicado por workers concorrentes.                                                                                                                          |
| Deduplicação por monitor | A observação usa provedor, data, empresa, horário, classe e benefício. O alerta e o preço em centavos são gravados na mesma transação. Nova queda de pelo menos 3% pode gerar outro aviso. |
| Revalidação pré-envio      | O despachante `drainAlerts` (`lib/monitoring/engine.ts`) confere o consentimento ativo do usuário, o status de contato verificado (`verified`), o frescor da oferta e se o horário da partida ainda está no futuro. Viagens que partiram durante o processamento são marcadas como `expired` sem consumir a cota de envio nem disparar mensagem. |
| Proteção contra inanição   | Alertas de contatos pendentes ou não verificados permanecem retidos sem bloquear nem consumir a oportunidade de envio de usuários verificados elegíveis.                                                                                                                                                                                         |
| Resultado incerto | Se o WhatsApp lança erro após iniciar a transmissão, a fila marca o alerta como `uncertain`. Se o processo cair, a próxima execução identifica a tentativa abandonada após dez minutos. Confira o aparelho antes de qualquer intervenção. |

## Verificação de aceite

- `tests/operational-regressions.test.ts`:
  - Alerta expirado não consome a cota de envio de destinatário verificado válido.
  - Destinatário não verificado não bloqueia envio para usuário verificado com oferta elegível.
- `tests/admin-whatsapp.test.ts` e `tests/contact-verification.test.ts`:
  - Viagem que parte durante o lookup do destinatário é cancelada e não consome a cota de envio.
  - Contato alterado, desativado ou deletado impede entrega de alertas pendentes.
  - Destinatário requer opt-in ativo com código de uso único; códigos expiram e bloqueiam após 5 tentativas incorretas.
- `tests/fastbus.test.ts`:
  - Workers concorrentes e reinícios preservam a reserva da tentativa e o estado incerto.
- `tests/price-validity.test.ts`:
  - Verificação estrita de validade temporal (`alertIsCurrent`) considerando hora exata de partida e prazo de 24 horas.
- `npm run typecheck`: aprovado sem erros.

## Itens concluídos

- [x] Separação conceitual e prática entre observação de oferta, intenção de alerta e despacho no transporte.
- [x] Deduplicação baseada em chave estável de negócio combinando viagem, benefício e usuário.
- [x] Gravação de estado `in_flight` no banco de dados antes da chamada externa ao transporte.
- [x] Revalidação completa de consentimento, número ativo e partida futura antes de disparar notificação.
- [x] Tratamento de resultados incertos sem disparo redundante cego.
- [x] Política de caducidade automática para ofertas cuja partida já ocorreu ou cujo frescor expirou.

## Testes executados

- [x] Um alerta pendente pode voltar à fila quando o destinatário é confirmado e a viagem continua válida.
- [x] Falha anterior à transmissão permite nova tentativa. A fila mantém o ID do alerta e interrompe a repetição automática quando a transmissão fica incerta.
- [x] Troca de número ou revogação de consentimento antes do envio impede entrega ao contato antigo.
- [x] Partida ocorrida durante a resolução do contato aborta o envio e cancela o alerta.

## Critério de conclusão

A fila suspende novas tentativas automáticas quando o resultado do envio fica incerto. Notificações somente são despachadas para contatos formalmente verificados com viagens que ainda não partiram.

## Migração e recuperação

A tabela de alertas suporta migrações aditivas de status. Alertas legados sem timestamp de partida são auditados pelo validador de frescor e descartados com segurança se ultrapassarem o limite de 24 horas.

[Voltar ao índice](README.md).

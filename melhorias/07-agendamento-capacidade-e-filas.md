# Agendamento, capacidade e filas duráveis

Prioridade: **P1**. Status: **concluído localmente em 05/11/2026**.

## Implementação e decisões entregues

| Componente                        | Comportamento entregue                                                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leases atômicas                   | `claimWorker` e `releaseWorker` (`lib/monitoring/lease.ts`) implementam controle de concorrência com lease durável no banco. Apenas um worker retém a posse da execução em determinado instante, e liberações só são aceitas se o identificador do proprietário coincidir. |
| Transações isoladas               | O wrapper de transações assíncronas (`lib/server/database.ts`) garante rollback automático em caso de exceção e isola operações concorrentes não relacionadas. Operações de rede são executadas estritamente fora do escopo transacional.                                  |
| Janela deslizante (14 dias)       | `targetFor` (`lib/monitoring/engine.ts`) orquestra o avanço por datas em janelas deslizantes de 14 dias sem pular partidas em viradas de mês ou mudanças de dia no calendário.                                                                                             |
| Isolamento de provedores pausados | Falhas consecutivas ou pausas por backoff em um provedor não travam nem atrasam a execução de outros provedores saudáveis vinculados ao mesmo monitor.                                                                                                                     |
| Segurança de acionamento (Cron)   | A rota `/api/cron/monitor` falha de forma estrita (fail-closed) na ausência do token de segredo (`CRON_SECRET`) e rejeita credenciais inválidas com HTTP 401.                                                                                                              |

## Verificação de aceite

- `tests/cloud-database.test.ts` (4/4 aprovados):
  - Rollback e isolamento em transações concorrentes assíncronas.
  - Concorrência de workers garantindo lease única durável e verificação de posse na liberação.
  - Validação estrita do intervalo de execução do cron em nuvem.
  - Proteção contra requisições desautorizadas no cron de monitoramento.
- `tests/operational-regressions.test.ts`:
  - Seleção contínua e determinística de datas na janela deslizante através de viradas de mês.
  - Provedor saudável consultado normalmente mesmo com provedor alternativo em pausa.
- `npm run typecheck`: aprovado sem erros.

## Itens concluídos

- [x] Dimensionamento de chamadas por combinação com controle de deadline por rodada.
- [x] Regras de cobertura com janela deslizante de até 14 dias sem lacunas de calendário.
- [x] Tarefas com transições de estado controladas e rastreabilidade por monitor.
- [x] Reivindicação atômica de trabalho por worker usando leases e verificação de posse.
- [x] Isolamento de fontes pausadas sem prejudicar o ciclo de fontes operacionais.
- [x] Proteção criptográfica e fail-closed de endpoints de cron e disparo automatizado.

## Testes executados

- [x] Uma fonte pausada e outra saudável: a saudável continua sendo consultada normalmente.
- [x] Dois workers concorrentes: apenas um obtém a lease ativa; o outro é bloqueado.
- [x] Rollback atômico em erro de transação sem afetar registros concorrentes válidos.
- [x] Rotação da janela deslizante em 14 datas sem perda de partidas em virada de mês.

## Critério de conclusão

A capacidade de monitoramento respeita os limites orçamentários e de concorrência. Reinícios e concorrência de processos são gerenciados por posse verificada, sem trabalho duplicado ou omissão de dias elegíveis.

## Migração e recuperação

A tabela de limites e leases é aditiva no SQLite e no Turso. Caso um worker caia abruptamente, a expiração da lease garante a retomada limpa pelo próximo ciclo sem necessidade de intervenção manual no banco de dados.

[Voltar ao índice](README.md).

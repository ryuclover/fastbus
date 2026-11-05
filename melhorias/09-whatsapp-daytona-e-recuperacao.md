# WhatsApp, Daytona e recuperação operacional

Prioridade: **P1/P2**. Status: **concluído localmente em 05/11/2026** (validação sintética e suíte de testes de protocolo/perfil 100% verde; homologação ponta a ponta com aparelho físico requer sessão e autorização real do operador em produção).

## Contexto e evidências

Sessão armazenada, processo ativo e mensagem recebida são fatos diferentes. O painel reporta com precisão o estado da sessão (perfil salvo, conectado, dormindo, restaurando) e o status do contato verificado.

Pontos de partida no código:

- [`lib/monitoring/whatsapp.ts`](../lib/monitoring/whatsapp.ts)
- [`lib/monitoring/session-profile.ts`](../lib/monitoring/session-profile.ts)
- [`lib/server/daytona-transport.ts`](../lib/server/daytona-transport.ts)
- [`app/api/whatsapp/route.ts`](../app/api/whatsapp/route.ts)
- [`app/api/admin/whatsapp/route.ts`](../app/api/admin/whatsapp/route.ts)
- [`tests/admin-whatsapp.test.ts`](../tests/admin-whatsapp.test.ts)
- [`tests/daytona-jobs.test.ts`](../tests/daytona-jobs.test.ts)
- [`tests/daytona-protocol.test.ts`](../tests/daytona-protocol.test.ts)
- [`tests/whatsapp-profile.test.ts`](../tests/whatsapp-profile.test.ts)

## Implementação concluída

1. **Ciclo de vida de sessão e perfil**:
   - `lib/monitoring/session-profile.ts` gerencia estado de sessão, lock exclusivo e checkpoint de perfil persistente.
   - Encerramento não chama `logout`, preservando tokens de autenticação sem forçar re-pareamento por QR Code a cada ciclo.

2. **Diferenciação clara entre remetente e destinatário**:
   - Destinatários são mantidos com flags de verificação de número e expiração individual.
   - Remetente roda sob processo isolado do Daytona / worker com lease atômico.

3. **Protocolo Daytona seguro e restrito**:
   - `lib/server/daytona-transport.ts` encapsula a comunicação via jobs RPC tipados com schema estrito, impedindo execução arbitrária de comandos bash.
   - A API do Daytona usa `DAYTONA_API_KEY` no backend. O canal do job exige um segredo Bearer temporário e separado, gerado para aquela execução.

4. **Preservação de co-locação (Olympus / Daytona)**:
   - Política de shutdown respeita atribuição de inicializador: o FastBus fecha seu próprio processo quando encontra o workspace já ligado. Quando ele mesmo acorda o workspace, solicita a parada ao concluir.

## Testes validados

- [x] `tests/admin-whatsapp.test.ts`: 10 testes cobrindo permissões administrativas, leitura e atualização de perfil WhatsApp, verificação de destinatário e proteção contra CSRF.
- [x] `tests/daytona-jobs.test.ts`: Validação de ciclo de vida de jobs e isolamento de execução.
- [x] `tests/daytona-protocol.test.ts`: Validação de payloads tipados, tratamento de erros HTTP e timeouts sem expor comandos arbitrários.
- [x] `tests/whatsapp-profile.test.ts`: Validação do isolamento de perfil e transição de estados de autenticação.

## Critério de conclusão

A arquitetura do transporte WhatsApp / Daytona possui separação formal de estados, locks de perfil, sanitização de logs e cobertura de testes automatizados com mocks de transporte. A restauração de uma sessão real deve ser conferida após o próximo despertar do workspace no painel administrativo.

[Voltar ao índice](README.md).

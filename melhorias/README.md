# Plano de melhorias do FastBus

Este diretório contém os guias de implementação técnica do FastBus. **Todos os guias (01 ao 13) estão concluídos localmente com suíte de 141 testes aprovados, tipagem estrita e build de produção validado.** Consulte o [registro de progresso](PROGRESSO.md) para os detalhes de implementação e critérios de cada módulo.

## Resumo dos Guias e Status

| Guia                                                                                        | Prioridade | Status          |
| ------------------------------------------------------------------------------------------- | ---------- | --------------- |
| [Contrato de ofertas e validação dos provedores](01-contrato-de-ofertas-e-validacao.md)     | P1         | Concluído local |
| [Localidades, terminais e conexões](02-localidades-terminais-e-conexoes.md)                 | P1         | Concluído local |
| [Preços, ID Jovem, vagas e validade](03-precos-beneficios-e-validade.md)                    | P1         | Concluído local |
| [Parsers e capacidades reais dos provedores](04-parsers-e-capacidades-das-fontes.md)        | P1         | Concluído local |
| [Transporte HTTP, orçamento e navegador](05-transporte-limites-e-navegador.md)              | P1/P2      | Concluído local |
| [Busca parcial, cache e retomada](06-busca-parcial-cache-e-retomada.md)                     | P1/P2      | Concluído local |
| [Agendamento, capacidade e filas duráveis](07-agendamento-capacidade-e-filas.md)            | P1         | Concluído local |
| [Alertas, deduplicação e entrega recuperável](08-alertas-deduplicacao-e-entrega.md)         | P1         | Concluído local |
| [WhatsApp, Daytona e recuperação operacional](09-whatsapp-daytona-e-recuperacao.md)         | P1/P2      | Concluído local |
| [Interface, estados e observabilidade](10-interface-estados-e-observabilidade.md)           | P2         | Concluído local |
| [Testes, versionamento, dependências e publicação](11-testes-versionamento-e-publicacao.md) | P1/P2      | Concluído local |
| [Referências e decisões](12-referencias-e-decisoes.md)                                      | —          | Concluído local |
| [Padrão de código e revisão](13-padrao-de-codigo-e-revisao.md)                              | —          | Concluído local |

## Comandos de Verificação do Projeto

| Comando             | Finalidade                                        | Resultado                               |
| ------------------- | ------------------------------------------------- | --------------------------------------- |
| `npm run typecheck` | TypeScript da aplicação e worker                  | 0 erros                                 |
| `npm test`          | Execução da suíte completa de testes unitários    | 141/141 testes passando     |
| `npm run build`     | Compilação completa (prebuild + Next + postbuild) | Build e sanitização de traces aprovados |

O teste integrado usa o build de produção, banco isolado e transporte simulado (`npm run test:e2e`). A disponibilidade das fontes e o recebimento no telefone têm verificação separada no painel administrativo.

Consulte o [padrão de código e revisão](13-padrao-de-codigo-e-revisao.md) para diretrizes de manutenção e evolução contínua.

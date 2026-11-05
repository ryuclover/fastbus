# Progresso das implementações

Status consolidado: **Todos os guias (01 ao 13) concluídos localmente com suíte de testes 100% verde (141/141) e typecheck / build aprovados.**

## Revisão de publicação em 05/11/2026

| Guias | Verificação reproduzível |
| --- | --- |
| 01–04 | Os testes de aquisição, contrato, mapeamento e preços percorrem as respostas sanitizadas até as ofertas. A tela, a API e o monitoramento consultam a mesma matriz de capacidades. O teste de ID Jovem passa pela seleção de uma oferta remanescente e pela validação usada no envio. |
| 05–07 | A suíte exercita pausas por fonte, limites de transporte, persistência parcial e retomada. No mesmo monitor, a reserva atômica escolhe a próxima fonte disponível. Quando todas estão em pausa, o monitor aguarda a liberação mais próxima. |
| 08–10 | A suíte cobre reserva concorrente de alerta, perda de confirmação, isolamento de destinatários e restauração de perfil. Os roteiros visuais exercitam busca, conversão em monitoramento, administração e celular com contas fictícias. |
| 11–13 | Rode `npm run typecheck`, `npm run format:check`, `npm test`, `npm run build` e `npm run test:e2e`. O último usa HTTPS local, banco temporário e o build de produção. Somente as integrações externas de coleta e envio são simuladas no fluxo de viagem. |

**Aceite operacional separado.** A revisão local não mede disponibilidade atual de inventário nem atesta entrega em aparelho real. Para validar uma instalação, use o diagnóstico da fonte e do remetente, envie a mensagem fixa ao destinatário confirmado e confira no celular. O cron configurado roda diariamente.

---

## Guia 11, 12 e 13 concluídos localmente

- **Publicação, Build e Traces (11)**:
  - Pipeline completo verificado com `npm run build` (`prebuild` com worker, `next build --webpack` e `postbuild`).
  - `scripts/build-traces.mjs` remove referências a dados privados dos manifests de build sem danificar dependências da aplicação.
  - Teste automatizado validado em `tests/build-traces.test.ts`.
- **Referências e Decisões (12)**:
  - Matriz de decisões consolidadas atualizada cobrindo cobertura, orçamento de requisições, frescor, precificação em centavos, identidade de rotas, entrega recuperável, concorrência e compatibilidade.
- **Padrão de Código e Revisão (13)**:
  - TypeScript strict verificado com sucesso para a aplicação e para o worker (`npm run typecheck`).
  - Suíte completa com 141 testes automatizados passando em `node:test` (`npm test`).
  - Checklist completo de revisão funcional e arquitetural validado.

---

## Guia 10 concluído localmente

- Estados canônicos de busca tipados com distinção entre vazio validado (`PROVIDER_EMPTY`), bloqueios (`outcome: "blocked"`), consulta orientativa manual (`outcome: "manual"`) e falha.
- Polling otimizado em `app/buscar/page.tsx`: frequência rápida (3s) durante execução ativa e reduzida (30s) em repouso.
- Pausa automática de polling quando a aba está em segundo plano (`document.hidden`) com reconciliação imediata em `visibilitychange`.
- Desacoplamento claro entre critérios de busca persistidos e filtros visuais de tabela (empresa e turno), com aviso explícito ao usuário ao converter busca em alerta.

---

## Guia 09 concluído localmente

- Ciclo de vida da sessão e perfil do WhatsApp isolado em `lib/monitoring/session-profile.ts` com lock exclusivo e encerramento limpo sem logout acidental.
- Protocolo do Daytona (`lib/server/daytona-transport.ts`) estritamente tipado por jobs RPC, sem exposição de comandos bash arbitrários.
- Preservação de ambientes compartilhados (Olympus) respeitando ownership de processos.
- Testes validados em `tests/admin-whatsapp.test.ts`, `tests/daytona-jobs.test.ts`, `tests/daytona-protocol.test.ts` e `tests/whatsapp-profile.test.ts`.

---

## Guia 08 concluído localmente

- Máquina de estados durável de alertas (`pending` -> `in_flight` -> `sent` / `expired`) com persistência antes do transporte.
- Deduplicação atômica por impressão digital por monitor (viagem, benefício, usuário).
- Revalidação prévia de partidas: viagens partidas antes do envio ou com dados expirados não acionam o canal de mensagens.
- Gerenciamento seguro de contatos com validação por código descartável de 4 dígitos em `lib/monitoring/contact-verification.ts`.
- Testes validados em `tests/contact-verification.test.ts` e `tests/whatsapp-store.test.ts`.

---

## Guia 07 concluído localmente

- Concorrência de workers coordenada por leases atômicas com verificação de dono (`claimWorker` e `releaseWorker` em `lib/monitoring/lease.ts`).
- Janela deslizante determinística de 14 dias para monitoramento contínuo sem estouro de capacidade.
- Endpoint de cron (`app/api/cron/monitor/route.ts`) protegido com modelo fail-closed exigindo segredo `CRON_SECRET`.
- Testes validados em `tests/cloud-database.test.ts` e `tests/operational-regressions.test.ts`.

---

## Guia 06 concluído localmente

- Cache delimitado de metadados de localidade com TTL de 6h e política LRU (`lib/monitoring/lookup-cache.ts`).
- Preservação e persistência imediata de resultados parciais em caso de interrupção ou falha de fontes subsequentes (`lib/monitoring/manual-search.ts`).
- Retomada de busca com controle de pausas (`nextAt`) e persistência segura em banco.
- Testes validados em `tests/manual-search.test.ts` e `tests/location-store.test.ts`.

---

## Guia 05 concluído localmente

- Orçamento de requisições gerenciado por `withRequestBudget` com deadline compartilhado.
- Tratamento rigoroso de `Retry-After` para segundos e datas HTTP com respeito à cadência dos provedores.
- Detecção imediata de desafios Cloudflare (HTTP 200 com HTML de desafio), interrompendo a busca sem disparar retentativas ou loops.
- Testes validados em `tests/polite-scraping.test.ts` e `tests/proxy-pacing.test.ts`.

---

## Guia 04 concluído localmente

- Matriz formal de capacidades dos provedores implementada em `types/providers.ts` e exposta em `lib/services/provedores.ts` (`PROVIDER_CAPABILITIES`).
- Gontijo configurada honestamente como busca manual/orientativa (`outcome: "manual"`), sem prometer inventário automatizado inexistente.
- Testes validados em `tests/providers.test.ts` (9/9 testes passando).

---

## Guia 03 concluído localmente

- Dinheiro em centavos padronizado por `parseProviderMoney` (`lib/money.ts`), com validação estrita de gramática monetária por fonte e rejeição de formatos ambíguos.
- Busca e envio revalidam a oferta de ID Jovem. A antecedência de reserva é apresentada na interface, e vagas remanescentes com evidência continuam elegíveis.
- Cálculo de validade temporal delimitado por frescor, partida e prazo explícito da fonte.
- Testes validados em `tests/price-validity.test.ts` (6/6 testes passando).

---

## Guia 02 concluído localmente

- Localidades e terminais com resolução canônica, persistência versionada e suporte a terminais específicos nas buscas e alertas.
- Conexões parciais marcadas com precisão sem mascarar trechos faltantes.
- Testes validados em `tests/location-store.test.ts` e na suíte de mappers.

---

## Guia 01 concluído localmente

- Contrato v1 com parsing Zod estrito e desacoplamento total entre parsing puro de scrapers e camada de transporte.
- Tratamento exaustivo de estados de retorno (`completed`, `partial`, `empty`, `blocked`, `failed`).
- Testes validados em `tests/result-contract.test.ts` e adaptadores de provedores.

---

[Voltar ao índice](README.md).

# Auditoria de usabilidade operacional do FastBus

Data: 30/10/2026. Escopo: interface publicada, configuração Vercel, estado persistido em produção, código do fluxo completo, suíte automatizada e teste integrado local. Nenhuma mensagem ou nova consulta a fornecedores foi disparada durante a auditoria. A lógica da aplicação e o deployment não foram alterados.

## Conclusão

O painel e a persistência estão funcionais, mas o serviço ainda não está comprovado como um monitor de passagens operacional de ponta a ponta. Em produção, a coleta está falhando e o remetente não possui sessão salva. Existem também falhas de cobertura do agendamento e de processamento da fila que os testes atuais não detectavam.

## Evidências de produção

Consultas SELECT realizadas em 30/10, aproximadamente às 09h09 de Brasília:

- Deployment Vercel READY; cron habilitado em `0 12 * * *` (diário).
- Uma conta e um monitoramento ativo: Rio de Janeiro → Salvador, ClickBus, ID Jovem 100%, preço máximo R$ 0, janela móvel de 14 dias, intervalo configurado de 1440 minutos.
- Monitor com cursor 9 e status `Fonte indisponível: ClickBus. Nova tentativa após a pausa.`
- Provedor ClickBus com nove falhas consecutivas registradas.
- Nenhum alerta armazenado. Isso não demonstra ausência de vagas: houve falha na coleta.
- Remetente com `desired=1`, `status=error`, sem backup de sessão, e sem diagnóstico em `last_error`.
- Contato desativado. Solicitação de confirmação expirada desde 19/10, `sent_at=NULL`, nenhuma tentativa de código. Não foi comprovado envio nem recebimento no celular.
- Existem registros de tentativas de execução diária entre 20 e 29/10. Contar tentativas de início não comprova sucesso de coleta ou entrega.

## Fluxo, etapa por etapa

| Etapa | Resultado | Limitação |
|---|---|---|
| Abrir o site | Página de login disponível | Mensagem inicial promete acompanhamento, mas a frequência reduzida aparece depois do login |
| Criar conta / entrar | Validado nos testes HTTP e E2E | Não há recuperação de senha pelo site |
| Salvar critérios / pausar / editar / excluir rota | Validado em testes e persistência real existente | Algumas fontes selecionáveis não confirmam ID Jovem automaticamente |
| Janela móvel | Configuração existe e não encerra pela data original | Percurso diário pode pular datas; ver reprodução abaixo |
| Agendamento Vercel | Habilitado; há tentativas persistidas | Uma combinação por execução diária para o sistema inteiro |
| Buscar disponibilidade real | Não validado em produção | Nove falhas consecutivas do ClickBus; causa específica não fica preservada no monitor |
| Parear WhatsApp | QR já havia sido gerado em testes anteriores | Não há sessão salva atualmente; restauração real após desligar/reabrir ainda não está comprovada |
| Solicitar / confirmar destinatário | Código implementado; fluxo simulado validado | Pedido real não foi enviado e já expirou |
| Criar oportunidade / deduplicar | Validado com fixtures | Depende de obter uma resposta real, elegível e confirmada |
| Entregar / tentar novamente | Validado com transporte simulado | Frequência diária e processamento de um único item podem adiar ou impedir avisos válidos |
| Mostrar histórico | Interface validada em E2E | Produção ainda não tem alertas para demonstrar o ciclo real |

## Achados prioritários

### P1 — Coleta principal indisponível na instalação real

O monitor está ativo, mas a fonte acumula nove falhas. A configuração salva e a execução do processo não equivalem a uma consulta bem-sucedida. O código exige navegador, inicialização da extensão Browsec, país de saída confirmado e compatibilidade com o conteúdo do ClickBus. A auditoria não atribui a falha a uma dessas dependências sem evidência adicional.

Referências: `lib/scrapers/clickbus/browser.ts`, `lib/monitoring/query-provider.ts`, `lib/monitoring/engine.ts:224`.

Necessário: preservar um diagnóstico sanitizado por execução e verificar uma única consulta real no mesmo ambiente Linux de produção, comparando com a página correspondente. Separar erro técnico de indisponibilidade de vagas. Não tentar contornar bloqueios repetindo chamadas ou alternando identidades.

### P1 — Remetente sem sessão e destinatário não confirmado

Sem backup, o worker não consegue restaurar o WhatsApp para enviar. O destinatário continua desativado porque o código real não foi enviado/confirmado. É necessário concluir pareamento, aguardar backup, enviar código, confirmar pela interface e testar novamente após encerrar e reabrir o navegador. Gerar QR é somente uma etapa intermediária.

Referências: `scripts/cloud-worker.ts:56`, `lib/monitoring/whatsapp.ts:153`, `lib/monitoring/contact-verification.ts`.

### P1 — Janela de 14 dias pode deixar datas permanentemente sem consulta

`targetFor` calcula a data usando o início móvel de hoje e um cursor que também avança. Na simulação com uma fonte e uma execução por dia:

| Dia da execução | Data consultada |
|---|---|
| 30/10 | 30/10 |
| 31/10 | 01/11 |
| 01/11 | 03/11 |
| 02/11 | 05/11 |

A data 31/10 nunca é consultada nessa simulação, embora esteja dentro da janela durante parte do período. Não basta testar que uma chamada retorna 14 datas diferentes mantendo o relógio parado.

Referência: `lib/monitoring/engine.ts:60`. Reprodução local, sem rede: `node --import tsx scratch/audit-rolling-window.mjs`.

Necessário: planejar cobertura por datas absolutas e acompanhar o que foi efetivamente verificado. Definir explicitamente a cobertura possível por execução. Com a frequência atual, uma chamada não varre as duas semanas.

### P1 — Fila de envio e retentativas incompatíveis com o ciclo diário

O worker em nuvem chama `deliverOne` uma vez e encerra. Essa função pode apenas expirar o primeiro item, ou adiar seu envio por um minuto, sem tentar outro item elegível. A próxima oportunidade de processamento é a execução diária, e avisos com mais de 24 horas expiram.

Reprodução isolada: uma fila com um alerta vencido seguido de um válido resulta em zero envios após a passagem única; o segundo permanece pendente. A execução reproduz o que a chamada única do worker faz. Isso demonstra risco de perda/atraso; não afirma que houve um alerta real perdido, pois produção não contém alertas.

Além disso, pedidos de código que chegam enquanto outro Sandbox está ocupado podem ficar pendentes. Um código que dura dez minutos não pode depender da chamada diária seguinte. `confirmContact` ativa o destinatário, mas não retoma por si só a fila de oportunidades.

Referências: `scripts/cloud-worker.ts:82`, `lib/monitoring/engine.ts:268`, `app/api/whatsapp/route.ts`. Reprodução: `npx tsx scratch/audit-alert-queue.ts`.

Necessário: processar itens elegíveis dentro do orçamento da execução e ter retomada compatível com os prazos de código/alerta, com limites claros de chamadas e custo. Tratar vencidos sem consumir toda a chance de entrega.

### P2 — Capacidade apresentada maior que a capacidade implementada

Gontijo sempre devolve lista vazia, direcionando ao portal; Águia Branca retorna `ID_JOVEM_UNCONFIRMED` quando solicitada a modalidade. Ainda podem ser selecionadas para monitoramento ID Jovem. Isso pode consumir a escassa execução diária sem possibilidade de gerar o aviso pretendido.

Referências: `lib/scrapers/gontijo/client.ts:51`, `lib/scrapers/aguiabranca/client.ts:78`, seleção de fontes em `app/page.tsx`.

Necessário: expor somente combinações de fonte/benefício automatizadas e verificadas, ou desabilitar explicitamente as incompatíveis. Manter a regra existente de não anunciar vaga manual ou não confirmada como oferta automática.

### P2 — Diagnóstico operacional insuficiente

O processo pode terminar com sucesso mesmo quando a consulta falhou. O monitor recebe mensagem genérica; o worker suprime detalhes no erro global e o `runCloudJob` não preserva um resultado operacional de coleta/entrega. Atualmente existe `status=error` no remetente sem `last_error`.

Necessário: distinguir início de execução, consulta válida, resultado vazio, bloqueio, erro de configuração e entrega confirmada; persistir horários e códigos sanitizados. O painel precisa mostrar último sucesso real e falhas recentes, em vez de somente processo ativo/inativo.

### P2 — Recuperação de acesso ausente

Há cadastro, login e troca de senha com a senha atual. Não há fluxo de esquecimento/recuperação. Um usuário que perde a senha depende de manutenção externa.

Referência: `app/api/account/[action]/route.ts:131` e tela de autenticação em `app/page.tsx`.

### P2 — Dependências precisam de nova triagem de segurança

`npm audit --omit=dev` reportou 15 entradas de alta severidade e nenhuma crítica em 30/10. Há propagação transitiva: não são necessariamente 15 causas independentes. Incluem a cadeia de WhatsApp/Puppeteer, Zod e dependências transitivas dos SDKs Vercel.

O advisory do Zod é `GHSA-mrhx-c7xc-m3w5` (consumo de memória ao validar coleções grandes). O limite de corpo JSON da aplicação reduz a superfície, mas não substitui a triagem. A exploração desses avisos não foi testada. O comando sugeriu também downgrades/mudanças incompatíveis para alguns pacotes; não foi executado `audit fix --force`.

## Validações e limites

- `npm run typecheck`: passou.
- `npm test`: 69/69 passaram.
- `npm run test:e2e`: passou; cadastro, cookies, CSRF, conta, contato e código simulado, monitoramento, fila, destinatário simulado, histórico, permissões e exclusão em banco isolado.
- Interface publicada: disponível, exibindo login; não foram usadas sessões administrativas artificiais nesta revisão.
- Produção: consultas de estado ao banco e configuração do cron/deployment.
- Simulações adicionais: cobertura móvel com relógio avançando; fila com item vencido antes de item válido.
- Não foram executados pareamento, envio real, reserva, novas consultas ClickBus ou mudanças em produção.

Os testes existentes são úteis e cobrem o painel e regras importantes, mas `scripts/verify-e2e.ts:28` declara explicitamente que provedores e transporte são fixtures. Portanto, o teste integrado não é prova de coleta e entrega reais.

## Ordem recomendada

1. Tornar as falhas diagnosticáveis e obter uma consulta válida no ambiente publicado.
2. Completar e provar o ciclo de WhatsApp, incluindo persistência e restauração da sessão.
3. Corrigir cobertura de datas e processamento/retomada de filas na frequência escolhida.
4. Executar um teste real controlado: fonte → oferta elegível → fila → número confirmado → mensagem → histórico, incluindo uma falha e recuperação.
5. Restringir fontes incompatíveis, adicionar recuperação de conta e tratar os avisos de dependências.

Até os quatro primeiros pontos serem concluídos, classificar a versão como experimental, e não como um serviço confiável de avisos automáticos.

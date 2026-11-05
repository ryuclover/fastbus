# Revisão de simplicidade e regressão do FastBus

## Refatorações

- Centralizadas as chamadas JSON da interface em `lib/api-client.ts`, preservando cookies, mensagens de erro e status HTTP usados para encerrar sessões inválidas. Painel, contato e administração compartilham o transporte.
- Unificados os tipos de usuário e a lista/tipo de provedores. A compatibilidade dos imports anteriores foi preservada com reexports. O modelo legado de passagem reutiliza a definição existente.
- Centralizadas as opções de segurança dos cookies de login e encerramento de sessão.
- Removida a ordenação redundante das candidatas do ClickBus: o filtro já exige a mesma propriedade usada pela ordenação. As duas construções de resultado para cotas de 100% e 50% agora usam um único laço, mantendo ordem, tarifa, quantidade e vínculo com a viagem.
- Unificada a fórmula de pausa exponencial da fonte para respostas de erro e exceções, preservando os mesmos intervalos.
- Eliminadas variáveis/imports não usados, coerções `as any` desnecessárias nas opções HTTP e ramos de gratuidade inacessíveis depois do retorno antecipado da Águia Branca.
- Removidos oito componentes da busca imediata que não tinham consumidores, o esqueleto de scraper sem implementação nem consumidores e a folha de estilos não importada. Os adaptadores e scripts históricos ainda referenciados foram mantidos.
- Retiradas as inclusões forçadas de binários de navegador nos pacotes das APIs: elas pertenciam à busca antiga, hoje desativada. A coleta continua no processo separado do worker.
- Corrigido o rastreamento automático de arquivos de produção: os manifests incluíam caminhos de bancos SQLite locais. Dados privados, perfis de navegador, arquivos de ambiente e resultados temporários agora são excluídos explicitamente. Como a exclusão nativa não foi efetiva neste Windows, `postbuild` filtra os manifests sem tocar nos arquivos de dados. O E2E verifica os manifests antes de iniciar o servidor e rejeita builds que voltem a incluir esses caminhos.

As diferenças entre os protocolos dos provedores foram mantidas explícitas. Não foi introduzida uma fábrica genérica de scrapers ou uma camada adicional de estado da interface. Os controles de concorrência, cancelamento, propriedade dos dados e consentimento continuam necessários.

## Validação reproduzível

Execute em sequência para evitar concorrência entre a recriação de `.next/types` pelo build e a leitura desses arquivos pelo TypeScript:

```sh
npm test
npm run format:check
npm run build
npm run typecheck
npm run test:e2e
```

A suíte contém 59 testes, incluindo regressões de cotas online, solicitações manuais ocultas, disponibilidade esgotada, preços inválidos, limites de chamadas, bloqueios, propriedade das contas, criptografia, reautenticação, deduplicação, envio com consentimento e exclusão de dados privados dos manifests de produção.

O teste integrado inicia uma instância de produção do Next em porta local livre, um proxy HTTPS local e um Chromium isolado. Usa chave, banco SQLite, contas e certificado temporários; encerra os processos e remove os dados ao terminar. Não carrega as credenciais da conta real no processo de teste nem inicia o worker do banco real.

Percurso integrado: cadastro pela interface → cookie seguro → contato autorizado → criar/pausar/retomar/editar monitoramento → parser de uma observação sanitizada do ClickBus → agendamento → alerta persistido → destinatário verificado → envio simulado → histórico na interface. Também verifica deduplicação, layout móvel, acesso administrativo ao QR, desconexão com senha, troca de senha, revogação de sessões, novo login e exclusão em cascata.

Pré-requisitos do E2E: build de produção, Chromium do Playwright e OpenSSL. No Windows, procura OpenSSL na instalação padrão do Git. `FASTBUS_TEST_OPENSSL` e `FASTBUS_TEST_CHROME_PATH` permitem indicar outros executáveis. Conexões locais e abertura do navegador precisam ser permitidas pelo ambiente de testes. Falhas produzem diagnóstico em `test-results/`, ignorado pelo Git.

## Limites da conclusão

O teste integrado usa aplicação, HTTP, HTTPS, banco, autenticação, parser, agendador e fila reais. As respostas externas do ClickBus, o QR e o transporte de envio são fixtures. Ele não comprova entrega em um celular real, disponibilidade atual de todas as fontes ou imunidade a mudanças e bloqueios externos. Nenhuma reserva nem mensagem real é necessária para reproduzir esses testes.

Amostras externas anteriores continuam documentadas em `diagnostics/clickbus-id-jovem.md`. Os utilitários antigos de inspeção não são uma suíte automática de regressão e não devem ser executados indiscriminadamente contra os sites.

Nenhum commit foi criado durante esta revisão.

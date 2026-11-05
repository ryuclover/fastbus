# Verificação de ID Jovem no ClickBus — 18–19/10/2026

**Conclusão atual:** o fluxo real do navegador com Browsec/EUA localizou cotas ID Jovem na amostra conferida. A consulta automatizada final de 18/11/2026 retornou **5 ofertas confirmadas**, com **7 chamadas de mercado e nenhum bloqueio**, sem reserva de assentos ou envio de WhatsApp. O transporte HTTP antigo continua sem validação. O sucesso desta amostra não garante cobertura de todas as rotas nem ausência de bloqueios futuros.

## Comparação da tela com os dados por data

Rota Rio de Janeiro/RJ → São Paulo/SP, somente ida, filtro de benefícios ativo. Navegação em Chromium isolado com User-Agent real, sem alterar sinalizações de automação ou resolver desafios. Entre as duas primeiras datas houve mais de sete minutos; a terceira foi conferida após a retomada da sessão, mais de doze horas depois.

| Data da viagem | Caso conferido | Tela oficial | Leitura corrigida |
| --- | --- | --- | --- |
| 18/11/2026 | Expresso do Sul, 08:30 | 2 ID Jovem 100%, 2 de 50% | Mesmas quantidades, fluxo online confirmado |
| 19/11/2026 | Catarinense, 09:00 | Ambas as cotas ID Jovem esgotadas | Zero em ambas; não gera oferta |
| 20/11/2026 | EXPRESSO NS PENHA, 17:00 | Solicitação manual por formulário | Inconclusivo; não anuncia vaga confirmada |

[Tela de 18/11](screenshots/clickbus-18-online.png), [tela de 19/11](screenshots/clickbus-19-exhausted.png), [tela de 20/11](screenshots/clickbus-20-manual.png). Foram feitas 4, 3 e 3 chamadas de mercado nessas rodadas, respectivamente, além dos recursos normais da página. Nenhuma poltrona foi selecionada. Os campos necessários, sem cookies nem cabeçalhos assinados, estão em `tests/fixtures/clickbus/` e alimentam testes de regressão.

## Fluxo incorporado ao worker

O coletor passou a carregar a página oficial e observar a resposta de viagens que o próprio frontend gera. A API continua em `/web/api/v6/trips`, no array `trips`. O frontend observado era `0.15.169`; o cliente antigo fixava `0.15.108` e Chrome 124. Essas diferenças não provam isoladamente a causa do HTTP 403, mas o fluxo oficial funciona sem reproduzir os cabeçalhos fixos antigos.

As candidatas online exigem classe convencional, `options.isGratuityTrip=true` e `options.hasGratuityCheckout=true`. Cada página de cotas precisa conter o `uuid` esperado, `travelCompany.hasGratuity=true` e tipos explícitos `YOUNG_ID`. `availableSeats` prevalece sobre `amount`; disponibilidade explicitamente desconhecida não recebe fallback. Páginas que apenas encaminham para solicitação manual são descartadas da lista de ofertas confirmadas.

A validação final usa o código de produção em `browser.ts`, com resultado em [clickbus-official-flow.json](clickbus-official-flow.json). Entre as cinco ofertas havia 100% e 50%; na Expresso do Sul, as quantidades conferidas manualmente foram encontradas novamente. Valores são **tarifas do benefício**, com taxas e total a confirmar na emissão. O painel e o WhatsApp explicitam essa distinção.

O ambiente local está configurado com `CLICKBUS_TRANSPORT=browser`, Chromium visível e Browsec isolado. O proxy é verificado antes das chamadas de mercado; o país dos EUA é conferido na inicialização. O modo headless não fez parte desta validação. O prazo de 90 segundos, a fila, o limite de oito chamadas de mercado e o controle global de pausas também se aplicam ao navegador. Recursos normais da página, como scripts e imagens, não entram nesse contador; páginas auxiliares de cotas não executam scripts.

**54 testes locais passaram**, incluindo os casos reais de vagas disponíveis, esgotamento e solicitação manual, além de verificação de tipos e compilação. Nenhum teste disparou mensagem real ou realizou reserva. As seções abaixo preservam o histórico das tentativas antigas, não a conclusão atual.

## Histórico: consulta real inicial

Foi executado o adaptador existente, no mesmo contexto de limites usado pelo worker, para Rio de Janeiro/RJ → São Paulo/SP, em 18/11/2026, com ID Jovem habilitado. O endpoint `/web/api/v6/trips` respondeu HTTP 403 (`Forbidden resource`) às 11:10:28 UTC. A execução foi interrompida após **uma única requisição**, sem consultar cotas, reservar assentos ou enviar WhatsApp.

A pausa mínima de 15 minutos foi registrada tanto no diagnóstico quanto no controle global de fontes do banco da aplicação. Nenhuma nova consulta deve ser feita antes de 11:25:28 UTC (08:25:28 em Brasília). Um HTTP 403 não demonstra que a causa seja bloqueio por IP: também pode haver incompatibilidade com o protocolo/cabeçalhos atuais da API.

O arquivo [clickbus-id-jovem-live.json](clickbus-id-jovem-live.json) registra o resultado do código **antes das correções** abaixo. Não é evidência de ausência de vagas. Nesta rodada não houve resposta real contendo cotas ID Jovem.

## Correções e testes locais

- O leitor aceita objetos `discounts` em JSON normal e em strings RSC escapadas pelo Next.js, sem substituir escapes indiscriminadamente.
- Quantidades precisam ser inteiras não negativas. Preço ausente, vazio, booleano, negativo ou não finito não vira gratuidade. Apenas `youngIdFullPrice` e `youngIdPartialPrice` são considerados; cotas de idosos não são confundidas com ID Jovem.
- Snapshots de cotas conflitantes, JSON truncado e conteúdo desconhecido são inconclusivos.
- As candidatas são consultadas em sequência, até seis por rodada e dentro das requisições restantes após resolver cidades e buscar viagens. O prazo total permanece 90 segundos e o espaçamento permanece entre 3 e 7 segundos.
- O cursor das candidatas avança entre consultas futuras, com cache em memória limitado a 100 rotas/datas. Reiniciar o worker reinicia esse cursor; o cursor principal de fonte/data continua persistido no banco.
- HTTP 403/404, payload inesperado, desafio HTML e verificação parcial sem oferta confirmada não são apresentados como ausência confirmada de vagas. Um desafio reconhecido em HTTP 200 também aciona a pausa global.
- As ofertas confirmadas levam à viagem específica, com o mesmo `tripId` consultado, sem selecionar ou bloquear poltrona.

Os testes usam respostas **sintéticas**, incluindo cotas de 100% e 50%, esgotamento, preço desconhecido, rotação de candidatas, limite de oito requisições e interrupção por bloqueio. Eles verificam o comportamento do código para esses formatos; não confirmam que o ClickBus atualmente entregue esse esquema de cotas em produção. A interpretação de `amount`/`price` precisa ser confrontada com uma resposta real antes de declarar o fluxo validado.

## Verificação isolada com Browsec

Após a pausa, a saída dos EUA foi confirmada e o mesmo adaptador foi executado via ponte HTTP do navegador. Às 11:26:06 UTC (08:26:06 em Brasília), `/web/api/v6/trips` retornou novamente HTTP 403 (`Forbidden resource`). A consulta parou após **uma requisição**; nenhuma página de cotas foi acessada. O controle global da fonte foi atualizado para aguardar pelo menos até 11:41:07 UTC (08:41:07 em Brasília). Não houve resolução de CAPTCHA nem repetição por outra localização.

O resultado completo está em [clickbus-id-jovem-browser.json](clickbus-id-jovem-browser.json). O sucesso anterior da página inicial e da API de lugares no Browsec não se estende, neste teste, à API de viagens. O esquema de cotas atual e sua correspondência com a tela oficial continuam sem confirmação real. O teste por navegador usa o User-Agent do adaptador para manter a assinatura existente; não é uma comparação com todo o fluxo interativo oficial do site.

O código corrigido passou em **48 testes locais**, verificação de tipos, formatação dos arquivos alterados e compilação de produção. O worker foi reiniciado com as correções e o remetente WhatsApp voltou ao estado `ready` a partir do backup existente. A integração Browsec é apenas um diagnóstico isolado: o worker continua com conexão direta, sem extensão.

O script `scripts/verify-clickbus-browser.mjs` permite rodar o mesmo adaptador em Chromium isolado com a extensão local, selecionando EUA e verificando o país de saída. Usa somente GET de documentos, bloqueia scripts e subrecursos das páginas consultadas e não acessa conta, checkout ou poltronas. O worker normal continua com o transporte já configurado; o script não instala a extensão nele.

O script respeita as pausas registradas nos dois diagnósticos e no banco antes de abrir o navegador. Antes da consulta, reserva atomicamente uma pausa de sete minutos no controle global, evitando sobreposição com o worker. Uma negativa de acesso estende essa pausa para pelo menos 15 minutos. Exemplo em PowerShell, após o fim da pausa:

```powershell
$env:BROWSEC_EXTENSION_PATH = 'C:/caminho/para/extensao-extraida'
$env:CLICKBUS_TEST_CHROME_PATH = 'C:/caminho/para/chromium/chrome.exe'
$env:CLICKBUS_TEST_DATE = '2026-11-18'
node --import tsx scripts/verify-clickbus-browser.mjs
```

É necessário um Chromium que permita extensões locais e uma cópia oficial do Browsec. Use perfil isolado, nunca o perfil pessoal nem o do WhatsApp. O arquivo do resultado é `clickbus-id-jovem-browser.json`. As pausas são precauções do FastBus, não limites oficiais publicados pelo ClickBus nem garantia de evitar bloqueios.

Referência do fluxo de usuário: [Central de Ajuda ClickBus — ID Jovem](https://atendimento.clickbus.com.br/hc/pt-br/articles/28849453097229-Como-reservar-passagem-com-ID-Jovem-Gratuidade-e-50-de-desconto).

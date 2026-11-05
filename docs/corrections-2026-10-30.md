# Correções operacionais — 30/10/2026

## Implementado

- Janela móvel ancorada em datas absolutas. O avanço diário do relógio e do cursor não pula mais dias alternados. A frequência gratuita continua sendo uma combinação por execução diária; a interface mostra cobertura efetiva das últimas 24 horas.
- Expiração em lote antes do envio. Contatos não confirmados não bloqueiam a fila dos confirmados. O worker processa vários itens dentro de seu prazo, respeitando os limites globais e por destinatário, e pode esperar retentativas próximas dentro da execução.
- A confirmação do telefone solicita retomada dos avisos. Pedidos de envio esperam até um minuto por uma execução ocupada e, se não puderem iniciar, deixam falha acionável em vez de um código pendente indefinidamente.
- Gontijo desabilitada na automação; Buser e Águia Branca desabilitadas para ID Jovem. API valida a mesma capacidade. Monitores antigos incompatíveis não geram falsas confirmações.
- Histórico sanitizado de consultas com códigos, datas e início/conclusão. Painel distingue última tentativa, última consulta concluída e cobertura atual. Cota ID Jovem não confirmada é resultado válido com aviso, não erro técnico que aumenta o backoff.
- Recuperação de senha por código de oito dígitos no WhatsApp já confirmado, dez minutos, cinco tentativas por desafio e limites por conta/número. Confirmação revoga sessões. Alternativa administrativa: `npm run admin -- email@exemplo.com --reset-password`, somente em ambiente confiável; preserva papel e exige troca de senha temporária. Nenhuma senha real foi redefinida nesta alteração.
- Zod da API 4.6.7, Next 16.4.3, Puppeteer 25.16.0 e Sandbox SDK 3.9.1. Sem downgrade forçado e sem overrides incompatíveis.

## Causa encontrada no coletor

A imagem universal atual executa em `/vercel`, enquanto a extensão era procurada em `/vercel/sandbox/browsec`. O caminho inexistente impedia a inicialização correta do Chromium. A configuração agora resolve `browsec` relativamente ao diretório da execução.

A imagem limpa também recebeu bibliotecas gráficas, D-Bus e Xvfb. Chromium usa sandbox e renderização por software. Testes reais no Sandbox confirmaram inicialização com e sem interface e, depois da correção do caminho, inicialização completa da extensão e confirmação da localização configurada.

O matcher da resposta de viagens tolera a normalização do sufixo `-todos`, a data ISO com horário e a barra final da mesma API, preservando cidade, destino e data. Um documento de bloqueio é identificado antes de esperar pela API. Timeout da resposta de viagens tem código específico; a consulta inteira continua limitada por orçamento e prazo.

## Validação e pendências externas

- 76 testes unitários/integrados passaram, incluindo novas regressões de calendário com relógio avançando, fila com item vencido, destinatário não confirmado, recuperação, fontes e diagnósticos.
- Typecheck, build de produção e E2E local passaram. O E2E passou também pela nova tela de recuperação com transporte simulado, login com nova senha de teste e exclusão da conta temporária.
- Após a pausa da fonte terminar, foi feita uma única consulta real no ambiente corrigido. O navegador iniciou, mas a consulta externa terminou com `BROWSER_TIMEOUT`, sem oferta confirmada e sem envio. A pausa foi preservada; não foi repetida a consulta para tentar contornar proteção ou limite.
- A configuração seguinte distingue `CLICKBUS_TRIPS_RESPONSE_TIMEOUT`, permite mais tempo para a resposta dentro do mesmo orçamento e registra o resultado da próxima execução. Isso ainda exige uma consulta concluída em produção para comprovar disponibilidade real.
- O pareamento do remetente e o recebimento/entrada do código no celular dependem do titular. Gerar QR ou passar em teste simulado não comprova esse passo.
- Persistem avisos de segurança transitivos de terceiros (incluindo extract-zip, basic-ftp e versões antigas de Zod em dependências). A atualização direta do Zod protege a validação da API, mas não elimina a árvore transitiva. Não foi testada exploração dessas falhas, nem foi aplicado o downgrade incompatível sugerido por `audit fix --force`.

Não declarar a entrega real ou a coleta de oportunidades como comprovadas enquanto essas etapas externas não forem concluídas.

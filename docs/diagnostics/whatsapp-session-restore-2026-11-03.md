# Restauração do remetente WhatsApp — 03/11/2026

## Evidências

- Pareamento chegava a `ready`, mas a execução seguinte voltava a `qr`; o pedido de confirmação permanecia pendente, com `sent_at=NULL`.
- A análise em memória do backup real encontrou 13.583.982 bytes comprimidos, 24 entradas e 21 arquivos de IndexedDB (60.975.648 bytes descomprimidos). Não havia arquivos de Local Storage, Local State, Session Storage, Network ou Preferences. Nenhum conteúdo de sessão, telefone, código ou arquivo descriptografado foi exportado.
- O snapshot de produção contém whatsapp-web.js 1.34.7, archiver 7.0.1 e unzipper 0.12.3, iguais aos componentes inspecionados localmente. A biblioteca copia um conjunto restrito de diretórios enquanto o navegador ainda está ativo.
- Ao encerrar, o worker classificava qualquer backup existente como `sleeping`, mesmo se a tentativa atual estivesse em `qr`. Portanto, o painel dizia "sessão salva" sem comprovar que a restauração funcionara.

A ausência de Local Storage comprova que o backup inspecionado estava incompleto para o novo critério de restauração. A captura de um perfil ativo é uma causa provável da ausência; não foi feita inspeção do conteúdo das credenciais para atribuir uma causa adicional ao WhatsApp.

## Correções

- Arquivar o perfil completo e isolado, incluindo Local State e as áreas de armazenamento de Default; excluir somente caches e locks conhecidos.
- No checkpoint final, fechar o Chromium normalmente, sem logout, antes de copiar/compactar o perfil. Isso permite que o navegador grave seus bancos no disco.
- Manter criptografia, serialização de backups, isolamento do diretório e exclusão dos artefatos temporários. Validar IndexedDB, Local Storage e caminhos do ZIP antes de substituir o backup anterior.
- Tratar backup antigo incompleto como motivo para pareamento, preservando-o até a gravação de uma substituição válida. Arquivos ausentes não podem ser reconstruídos a partir do arquivo antigo.
- Respeitar o intervalo inicial de estabilização de uma nova sessão; uma restauração válida não precisa repetir essa espera.
- Registrar erro de restauração ao encerrar em QR. Um backup antigo não transforma uma tentativa de autenticação malsucedida em sessão salva.
- Usar a sessão administrativa autenticada para configurar o remetente, sem pedir a senha novamente. Permanecem autorização administrativa, exigência de troca da senha temporária, CSRF e limites de frequência.

## Validação

- Teste com Chromium real no Windows: Local Storage, IndexedDB e cookie artificiais sobreviveram a encerramento, backup criptografado, extração em outro diretório e reabertura.
- O mesmo teste passou no snapshot Linux/Chromium da Vercel, sem credenciais de WhatsApp, consultas a provedores ou mensagens reais. A execução de diagnóstico foi encerrada.
- Testes cobrem rejeição de arquivos incompletos sem substituir o backup anterior, cancelamento de timers, estabilidade inicial, ausência de falso `sleeping`, acesso administrativo sem senha repetida e preservação de CSRF/isolamento.
- 88 testes passaram; typecheck e build de produção passaram.

O ciclo real WhatsApp → backup novo → nova execução → envio ainda requer parear pelo menos uma vez com a versão corrigida e confirmar o destinatário pelo código recebido. O contador interno de pareamentos em 03/11 já estava em três antes da publicação; ele não foi alterado durante a investigação.

## Referências

- [Autenticação no whatsapp-web.js](https://wwebjs.dev/guide/creating-your-bot/authentication.html)
- [Código de RemoteAuth 1.34.7](https://docs.wwebjs.dev/authStrategies_RemoteAuth.js.html)
- [Relato de restauração e captura de perfil no repositório oficial](https://github.com/wwebjs/whatsapp-web.js/issues/5781)

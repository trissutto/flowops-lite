# Banner Linha Conforto

## Objetivo

Publicar na capa do e-commerce uma campanha da Linha Conforto, com artes próprias para desktop e celular, levando a cliente diretamente para `/categoria/linha-conforto`. Corrigir a experiência da Retaguarda para que salvar e publicar seja uma operação clara e verificável.

## Artes

- Desktop: arte panorâmica de 2400 × 900 px, com área segura para cortes responsivos.
- Mobile: arte vertical de 1080 × 1350 px, recomposta para telas estreitas; não será apenas um recorte automático do desktop.
- Mensagem: “LINHA CONFORTO”, “Leveza que veste você.” e “CONHEÇA A COLEÇÃO”.
- As duas versões preservam as modelos, as roupas e a identidade visual aprovada.

## Cadastro do banner

O banner ocupará o slot `home-hero` e usará:

- imagem desktop no campo `imagemUrl`;
- imagem mobile no campo `imagemMobileUrl`;
- CTA “CONHEÇA A COLEÇÃO”;
- destino relativo `/categoria/linha-conforto`, válido nos domínios atual e redirecionado do e-commerce;
- texto alternativo descritivo para acessibilidade.

## Correção da Retaguarda

O card do banner terá uma ação explícita “Salvar e publicar”. Essa ação salvará os textos, links, ordem e janela antes de ativar o banner, evitando publicar dados antigos. A interface validará a presença da imagem desktop e um destino interno seguro, mostrará o progresso da operação e só confirmará sucesso depois de o backend devolver o registro ativo.

O upload desktop e mobile continuará separado. A tela exibirá as dimensões recomendadas e manterá o formulário preenchido durante uploads. Erros de upload, salvamento ou publicação permanecerão visíveis no próprio card.

## Backend e dados

Não haverá mudança de schema. Os endpoints existentes de upload e atualização serão reutilizados. O backend continuará otimizando imagens para WebP e avisando o e-commerce para invalidar o cache. A mudança de interface será compatível com banners já cadastrados.

## Verificação

- Testar o fluxo de salvar e publicar com imagem desktop e mobile.
- Confirmar que o registro público de `home-hero` retorna as duas URLs, o CTA e `/categoria/linha-conforto`.
- Validar que a ação não publica quando falta imagem desktop ou quando o link é inválido.
- Executar lint/testes do frontend e os testes relevantes de `site-banners` no backend.
- Conferir visualmente as duas artes e o preview responsivo da Retaguarda.

## Fora de escopo

O deploy e a publicação na produção permanecem manuais. Não serão alteradas outras campanhas, vitrines ou categorias.

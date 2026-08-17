# Otimização de banners no upload

## Objetivo

Eliminar o cache frio do otimizador do Next.js como gargalo do LCP da home. Hoje o upload grava PNGs grandes diretamente no R2; o primeiro acesso precisa buscar o original, convertê-lo e só então pintar o banner.

## Decisão

O backend converterá cada banner antes do upload. A URL persistida no CRM apontará para o derivado WebP pronto, e o objeto será servido com cache longo e imutável.

## Fluxo

1. O administrador escolhe uma imagem na tela de banners.
2. O backend valida que o arquivo é uma imagem suportada.
3. `sharp` aplica rotação EXIF, remove metadados, limita a largura sem ampliar e converte para WebP.
4. A variante desktop usa largura máxima de 2216 px; a mobile, 992 px.
5. O novo objeto é gravado no R2 com `Content-Type: image/webp` e `Cache-Control: public, max-age=31536000, immutable`.
6. Somente após o upload concluir o banco recebe a nova URL.
7. O objeto anterior é apagado em modo best-effort.
8. A vitrine é revalidada pelo mecanismo existente.

## Qualidade e limites

- Qualidade WebP: 82, com esforço de compressão equilibrado.
- Proporção preservada; nunca há recorte ou ampliação.
- Metadados são removidos.
- Arquivos vazios, corrompidos ou não reconhecidos retornam erro acionável.
- A chave ganha extensão `.webp`, independentemente do nome original.
- Banners já publicados não são migrados automaticamente; o próximo upload já usa o pipeline novo.

## Contrato e interface

O endpoint atual e os campos `imagemUrl`/`imagemMobileUrl` permanecem compatíveis. A resposta do upload inclui metadados opcionais de otimização (`originalBytes`, `optimizedBytes`, `width`, `height`, `format`) para permitir feedback visual posterior sem bloquear esta entrega.

## Falhas e consistência

- Falha na conversão: não envia nada e não altera o banco.
- Falha no upload: não altera o banco nem apaga o objeto anterior.
- Falha ao apagar o anterior: registra aviso, mas preserva o banner novo.
- Falha na revalidação: mantém o comportamento best-effort existente.

## Testes

- converte PNG/JPEG válido em WebP;
- respeita o teto de largura por variante;
- não amplia imagem menor;
- envia `ContentType` e `CacheControl` corretos ao R2;
- usa chave `.webp` sanitizada;
- não atualiza banco quando conversão ou upload falha;
- mantém substituição segura e revalidação existentes;
- build do backend aprovado.

## Fora de escopo

- migração em lote dos banners antigos;
- alteração do componente Hero ou inclusão de novos preloads;
- mudança visual na campanha;
- instalação do plugin Cloudflare ou troca do provedor de armazenamento.

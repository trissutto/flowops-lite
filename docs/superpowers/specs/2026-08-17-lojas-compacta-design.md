# Página Nossas Lojas compacta

## Objetivo

Reduzir o comprimento da página `/lojas`, principalmente no celular, e levar a visitante ao localizador ou à compra online mais rapidamente. A página deve continuar transmitindo presença física e acolhimento, sem esconder endereço, telefone, Instagram ou WhatsApp das unidades.

## Estrutura aprovada

1. **Capa compacta**
   - Preservar a imagem atual.
   - Reduzir a altura de `100svh` para aproximadamente `55svh` no celular e `70svh` no desktop.
   - Encurtar o texto institucional.
   - Manter os botões `Encontrar minha loja` e `Comprar online` visíveis na capa.
   - Remover a seta animada inferior, pois a busca já aparecerá logo abaixo.

2. **Localizador prioritário**
   - Posicionar `Qual cidade é a sua?` imediatamente depois da capa.
   - Manter busca por cidade, sugestão automática e geolocalização.
   - Após a seleção, destacar a unidade mais adequada e oferecer ações diretas: rota, WhatsApp, telefone e Instagram.
   - Preservar parâmetros UTM nos caminhos de compra online.

3. **Lista compacta de lojas**
   - Diminuir margens, títulos e altura dos cards no celular.
   - Exibir inicialmente as informações essenciais: cidade/unidade, bairro, endereço resumido e status de seleção.
   - Manter os detalhes completos no drawer já existente.
   - Organizar os cards em lista compacta no celular e grade no desktop.

4. **Conteúdo comercial**
   - Posicionar a vitrine de compra online após a lista de lojas.
   - Manter produtos reais e o botão de compra online.
   - Preservar a barra móvel de campanha, sem cobrir botões ou conteúdo.

5. **Conteúdo institucional condensado**
   - Unir manifesto, motivos para visitar e depoimentos em uma única seção curta.
   - Remover repetições de mensagens sobre acolhimento, provadores e atendimento.
   - Manter um CTA final compacto com a loja selecionada.
   - Manter Instagram e rodapé, reduzindo espaços verticais.

## Componentes afetados

- `Hero`: altura, espaçamento, texto e remoção da seta.
- `NossasLojasClient`: nova ordem das seções.
- `SearchLocate`: espaçamento menor e resultado mais acionável.
- `StoresSection` e `StoreCard`: densidade visual maior no celular.
- `Manifesto`, `WhyVisit` e `Testimonials`: consolidação em uma seção compacta.
- `OnlineShoppingSection`, `InstagramCta`, `FinalCta` e rodapé: redução de margens.

Os dados das lojas, a geolocalização, o drawer, os eventos de rastreamento e os links atuais não serão reescritos.

## Comportamento e falhas

- Se a geolocalização for negada, a busca manual continuará disponível e visível.
- Se nenhuma cidade corresponder, a página mostrará orientação para revisar a busca sem ocultar a lista.
- Se a vitrine online estiver indisponível, o localizador e os cards das lojas continuarão funcionando.
- A página não solicitará localização automaticamente; a visitante continuará iniciando a ação.

## Critérios de aceitação

- Em uma tela móvel de 400 × 1218, a capa e o começo do localizador devem aparecer na primeira dobra ou imediatamente após um único gesto curto.
- Os dois CTAs da capa permanecem funcionais.
- Busca, geolocalização, seleção de loja e drawer continuam funcionando.
- Endereço, rota, WhatsApp, telefone e Instagram continuam acessíveis.
- A página perde seções repetitivas e fica materialmente mais curta.
- Desktop permanece editorial, mas também recebe espaçamentos menores.
- Build de produção e verificações de tipos passam.
- Não há regressão nos parâmetros UTM nem nos eventos existentes.

## Fora do escopo

- Alterar dados, endereços ou canais das lojas.
- Criar mapa permanente na página.
- Solicitar localização automaticamente.
- Trocar a fotografia atual da capa.
- Modificar checkout, catálogo ou regras promocionais.

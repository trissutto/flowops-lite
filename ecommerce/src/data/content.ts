import type { InstagramPost, TaxonomyCard, Testimonial } from '@/types';

/**
 * CONTEÚDO DE VITRINE
 *
 * ⚠️ PLACEHOLDER ESTRUTURAL. O que sobrou aqui são TEXTOS e TAXONOMIAS —
 * nenhuma foto. O que é real: a taxonomia (ocasiões, tecidos, modelagens) e a
 * faixa de numeração 44–60, que refletem a operação da Lurds.
 *
 * ── SEM FOTO DE BANCO DE IMAGEM (16/08/2026) ──
 *
 * Este arquivo era o depósito de fotos do Unsplash do site: 16 URLs que
 * alimentavam o hero da home, a grade do Instagram, os cards de ocasião, os
 * editoriais, os produtos de maquete e as duas fotos institucionais. O dono
 * mandou arrancar do ar toda foto que não é oficial da Lurds — modelo de
 * outra marca vestindo peça que não é nossa é promessa que a loja não cumpre.
 *
 * Junto com as URLs saíram os dados que só existiam pra carregá-las:
 *   · `newArrivals`/`bestSellers`/`looks` — catálogo de maquete, já sem uso
 *     (a vitrine real vem de `services/vitrine.ts`);
 *   · `editorials`/`editorialGridItems` — artigos de um blog que não existe;
 *   · `institutionalVideo` — vídeo de banco (Pexels) de uma loja masculina;
 *   · `peopleImage`/`storeInteriorImage` — "nossa loja" que não era nossa.
 *
 * Cada tela que usava isso tem o caminho SEM foto pronto; nenhuma depende de
 * imagem pra ficar de pé. Foto oficial entra pelo cadastro da retaguarda
 * (banners, categorias, peças) — não volta a ser constante neste arquivo.
 */

/* -------------------------------------------------------------------- HERO */

/**
 * Hero ESTÁTICO da home — o fallback de quando a retaguarda não tem campanha
 * no slot `home-hero` (ver `services/banners.ts`).
 *
 * A imagem editorial oficial fica resolvida em `services/banners.ts`. Ela é o
 * fallback seguro quando não existe campanha no CRM e também substitui apenas
 * a antiga arte fechada "Indomável". Títulos ficam como texto puro (`lead` +
 * `emphasis`), para permanecerem acessíveis, responsivos e nítidos.
 */
export const homeHero = {
  eyebrow: 'Nova coleção',
  lead: 'Moda que valoriza',
  emphasis: 'você',
  subtitle:
    'Novidades do 46 ao 60, com caimento pensado para o corpo real.',
};

/* ---------------------------------------------------------------- MANIFESTO */

export const manifesto = {
  eyebrow: 'Nosso propósito',
  title: 'Desde 1979 vestindo autoestima.',
  paragraphs: [
    'A Lurds nasceu de uma inconformidade simples: por que roupa bonita só existia até certo número? Décadas depois, seguimos respondendo isso com curadoria — não com tamanho grande de peça pequena.',
    'Cada peça passa pelo teste que importa: veste bem no corpo real, aguenta o dia inteiro e faz você se olhar no espelho com orgulho.',
  ],
  stats: [
    { value: '1979', label: 'Desde' },
    { value: '14', label: 'Lojas' },
    { value: '500 mil+', label: 'Clientes' },
    { value: '44–60', label: 'Numeração' },
  ],
};

/* --------------------------------------------------------------- TAXONOMIAS */

/** Ocasiões — sem foto (ver o topo do arquivo): título e promessa bastam. */
export const occasions: TaxonomyCard[] = [
  { slug: 'trabalho', title: 'Trabalho', description: 'Alfaiataria que respira', href: '/ocasioes/trabalho' },
  { slug: 'casamento', title: 'Casamento', description: 'Convidada e madrinha', href: '/ocasioes/casamento' },
  { slug: 'festa', title: 'Festa', description: 'Brilho na medida', href: '/ocasioes/festa' },
  { slug: 'viagem', title: 'Viagem', description: 'Não amassa na mala', href: '/ocasioes/viagem' },
  { slug: 'dia-a-dia', title: 'Casual', description: 'Conforto sem descuido', href: '/ocasioes/dia-a-dia' },
  { slug: 'praia', title: 'Praia', description: 'Litoral com estilo', href: '/ocasioes/praia' },
  { slug: 'jantar', title: 'Jantar', description: 'Sofisticado e discreto', href: '/ocasioes/jantar' },
  { slug: 'igreja', title: 'Igreja', description: 'Elegância serena', href: '/ocasioes/igreja' },
];

export const fabrics: TaxonomyCard[] = [
  { slug: 'viscolycra-premium', title: 'Viscolycra premium', description: 'Cai como líquido, veste todo dia', href: '/tecidos/viscolycra-premium' },
  { slug: 'jeans', title: 'Jeans', description: 'Estrutura com elastano de verdade', href: '/tecidos/jeans' },
  { slug: 'linho', title: 'Linho', description: 'Fresco pro calor do Brasil', href: '/tecidos/linho' },
  { slug: 'crepe', title: 'Crepe', description: 'Toque seco, caimento nobre', href: '/tecidos/crepe' },
  { slug: 'tricot', title: 'Tricot', description: 'Aconchego sem volume', href: '/tecidos/tricot' },
  { slug: 'alfaiataria', title: 'Alfaiataria', description: 'A peça que resolve a semana', href: '/tecidos/alfaiataria' },
];

/** Modelagem — seção educativa (sem foto, tipografia grande). */
export const fits: TaxonomyCard[] = [
  { slug: 'valoriza-cintura', title: 'Valoriza a cintura', description: 'Recortes e amarrações que marcam a silhueta no lugar certo — sem apertar.', href: '/modelagem/valoriza-cintura' },
  { slug: 'disfarca-barriga', title: 'Disfarça a barriga', description: 'Caimento solto na altura do abdômen, com tecido que não marca.', href: '/modelagem/disfarca-barriga' },
  { slug: 'alonga-silhueta', title: 'Alonga a silhueta', description: 'Linhas verticais, fendas e comprimentos que esticam visualmente.', href: '/modelagem/alonga-silhueta' },
  { slug: 'modelagem-solta', title: 'Modelagem solta', description: 'Liberdade total de movimento pro dia inteiro, sem parecer larga.', href: '/modelagem/modelagem-solta' },
  { slug: 'alfaiataria', title: 'Alfaiataria', description: 'Estrutura que sustenta a postura e resolve qualquer compromisso.', href: '/modelagem/alfaiataria' },
  { slug: 'conforto-total', title: 'Conforto total', description: 'Cós elástico, malha macia e zero incômodo — do home office ao passeio.', href: '/modelagem/conforto-total' },
];

/* --------------------------------------------------------------- DEPOIMENTOS */

export const testimonials: Testimonial[] = [
  {
    id: 't01',
    name: 'Cliente Lurds',
    city: 'São Paulo · SP',
    quote: 'As roupas vestem super bem, valorizam o corpo de verdade e têm muita qualidade.',
    rating: 5,
    fit: { height: '1,62 m', weight: '92 kg', sizeBought: '50' },
    productName: 'Vestido envelope clássico',
  },
  {
    id: 't02',
    name: 'Cliente Lurds',
    city: 'Campinas · SP',
    quote: 'Atendimento acolhedor do começo ao fim. Saí da loja me sentindo linda.',
    rating: 5,
    fit: { height: '1,70 m', weight: '105 kg', sizeBought: '54' },
    productName: 'Conjunto alfaiataria fluida',
  },
  {
    id: 't03',
    name: 'Cliente Lurds',
    city: 'Santos · SP',
    quote: 'Finalmente uma loja onde eu provo, gosto e levo. O caimento é perfeito.',
    rating: 5,
    fit: { height: '1,58 m', weight: '88 kg', sizeBought: '48' },
    productName: 'Calça jeans cintura alta',
  },
  {
    id: 't04',
    name: 'Cliente Lurds',
    city: 'Jundiaí · SP',
    quote: 'Qualidade impecável e um provador sem pressa. Virou minha loja de sempre.',
    rating: 5,
    fit: { height: '1,66 m', weight: '110 kg', sizeBought: '56' },
    productName: 'Macacão pantalona',
  },
];

/* ---------------------------------------------------------------- INSTAGRAM */

/** Perfil oficial. Num lugar só — aparece no card, no CTA e no rodapé. */
export const PERFIL_INSTAGRAM = 'https://www.instagram.com/lurdsplussize';

/**
 * GRADE DO INSTAGRAM — hoje VAZIA de propósito.
 *
 * Isto era a rede de segurança de `services/instagram.ts`: se a Graph API
 * falhasse, a home mostrava seis fotos de banco de imagem no lugar dos posts
 * reais da @lurdsplussize. Ou seja, justamente na seção de prova social a
 * cliente veria o feed de outra marca — e ninguém perceberia a falha.
 *
 * Com a lista vazia o serviço devolve `[]` e a seção some da página até o
 * Instagram voltar. Seção ausente é menos grave que seção mentindo.
 *
 * ⚠️ NÚMERO DE CURTIDA E "PEÇAS MARCADAS" JÁ TINHAM SAÍDO EM 10/08/2026 —
 * contagem escrita à mão apresentada como engajamento real é o mesmo problema
 * que tirou os depoimentos do ar em 06/08: prova social fabricada é
 * publicidade enganosa (CDC), não licença poética.
 */
export const instagramPosts: InstagramPost[] = [];

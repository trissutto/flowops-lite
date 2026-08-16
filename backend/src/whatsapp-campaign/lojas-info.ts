// GERADO de ecommerce/src/data/lojas.json (copia p/ o backend usar na Lulu).
// Dado de referencia estatico das lojas fisicas — endereco/telefone/horario.
// Se mudar a lista publica, regerar. NUNCA a IA deve inventar endereco: se a
// cidade nao estiver aqui, manda pra www.lurdsplussize.com.br/lojas.

export interface LojaInfo {
  unidade: string;
  cidade: string;
  endereco: string;
  telefone: string;
  whatsapp: string;
  horario: string;
}

export const LOJAS: LojaInfo[] = [
  {
    "unidade": "Anália Franco",
    "cidade": "São Paulo/SP",
    "endereco": "Rua Padre Landell de Moura, 172 - Jardim Anália Franco",
    "telefone": "(11) 97810-6947",
    "whatsapp": "5511978106947",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "Campinas",
    "cidade": "Campinas/SP",
    "endereco": "Rua General Osório, 1989 - Cambuí",
    "telefone": "(19) 99670-4712",
    "whatsapp": "5519996704712",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "Indaiatuba",
    "cidade": "Indaiatuba/SP",
    "endereco": "Rua Nove de Julho, 638 - Centro",
    "telefone": "(19) 99725-0291",
    "whatsapp": "5519997250291",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "Itanhaém",
    "cidade": "Itanhaém/SP",
    "endereco": "Av. Harry Forssell, 159 - Belas Artes",
    "telefone": "(13) 99625-6238",
    "whatsapp": "5513996256238",
    "horario": "Segunda a sábado · 9h às 19h"
  },
  {
    "unidade": "Jundiaí",
    "cidade": "Jundiaí/SP",
    "endereco": "Av. Jundiaí, 285 - Anhangabaú",
    "telefone": "(11) 99785-0504",
    "whatsapp": "5511997850504",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "Limeira",
    "cidade": "Limeira/SP",
    "endereco": "Rua Treze de Maio, 144 - Centro",
    "telefone": "(19) 99602-0270",
    "whatsapp": "5519996020270",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "Moema",
    "cidade": "São Paulo/SP",
    "endereco": "Alameda dos Maracatins, 156 - Indianópolis",
    "telefone": "(11) 98419-5667",
    "whatsapp": "5511984195667",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "Piracicaba",
    "cidade": "Piracicaba/SP",
    "endereco": "Rua do Rosário, 2405 - Paulista",
    "telefone": "(19) 99188-0190",
    "whatsapp": "5519991880190",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "Praia Grande",
    "cidade": "Praia Grande/SP",
    "endereco": "Av. Presidente Kennedy, 6527 - Vila Caiçara",
    "telefone": "(13) 99796-9061",
    "whatsapp": "5513997969061",
    "horario": "Segunda a sábado · 10h às 19h"
  },
  {
    "unidade": "Santos",
    "cidade": "Santos/SP",
    "endereco": "Av. Ana Costa, 549 – Loja 63A - Gonzaga",
    "telefone": "(13) 99608-7341",
    "whatsapp": "5513996087341",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "São José dos Campos",
    "cidade": "São José dos Campos/SP",
    "endereco": "Av. Dr. Adhemar de Barros, 1400 - Jardim São Dimas",
    "telefone": "(12) 99677-1646",
    "whatsapp": "5512996771646",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "Sorocaba",
    "cidade": "Sorocaba/SP",
    "endereco": "Rua Duque de Caxias, 109 - Vila Leão",
    "telefone": "(15) 99862-6002",
    "whatsapp": "5515998626002",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "Suzano",
    "cidade": "Suzano/SP",
    "endereco": "Rua Dona Augusta Aparecida de Carvalho Moraes, 85 - Centro",
    "telefone": "(11) 94316-0284",
    "whatsapp": "5511943160284",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  },
  {
    "unidade": "Vinhedo",
    "cidade": "Vinhedo/SP",
    "endereco": "Av. Brasil, 598 - Jardim Brasil",
    "telefone": "(11) 96411-6506",
    "whatsapp": "5511964116506",
    "horario": "Segunda a sexta · 9h às 18h | Sábado · 9h às 13h"
  }
];

/** Bloco compacto pra dar de contexto pra IA. */
export function lojasComoTexto(): string {
  return LOJAS.map(
    (l) => `- ${l.unidade} (${l.cidade}): ${l.endereco}. Tel/WhatsApp ${l.telefone}. Horario: ${l.horario}`,
  ).join('\n');
}

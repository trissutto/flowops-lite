import {
  BarChart3,
  Boxes,
  ClipboardList,
  Database,
  PackageSearch,
  Settings2,
  Shirt,
  Tags,
} from 'lucide-react';

export const MODULE_BASE_PATH = '/retaguarda/produto-estoque';

export const produtoEstoqueNav = [
  {
    href: `${MODULE_BASE_PATH}/produtos`,
    label: 'Produtos',
    shortLabel: 'Produtos',
    icon: PackageSearch,
  },
  {
    href: `${MODULE_BASE_PATH}/entradas`,
    label: 'Entradas & Etiquetas',
    shortLabel: 'Entradas',
    icon: Tags,
  },
  {
    href: `${MODULE_BASE_PATH}/estoque`,
    label: 'Estoque & Movimentações',
    shortLabel: 'Estoque',
    icon: Boxes,
  },
  {
    href: `${MODULE_BASE_PATH}/inteligencia`,
    label: 'Inteligência',
    shortLabel: 'Inteligência',
    icon: BarChart3,
  },
  {
    href: `${MODULE_BASE_PATH}/cadastros`,
    label: 'Cadastros auxiliares',
    shortLabel: 'Cadastros',
    icon: Settings2,
  },
] as const;

export const produtosNav = [
  {
    href: `${MODULE_BASE_PATH}/produtos`,
    label: 'Ficha Master',
    description: 'Fotos, conteúdo, grade por loja e movimentação',
    icon: Database,
  },
  {
    href: `${MODULE_BASE_PATH}/produtos/grade-geral`,
    label: 'Grade geral & edição',
    description: 'Estoque, preço e descrição em bloco',
    icon: Boxes,
  },
  {
    href: `${MODULE_BASE_PATH}/produtos/pendencias`,
    label: 'Pendências da ficha',
    description: 'Fila priorizada para completar o site',
    icon: ClipboardList,
  },
  {
    href: `${MODULE_BASE_PATH}/produtos/classificacao`,
    label: 'BÁSICO / MODA',
    description: 'Classificação comercial dos produtos',
    icon: Shirt,
  },
] as const;

export function isModuleNavActive(pathname: string, href: string) {
  if (href === `${MODULE_BASE_PATH}/produtos`) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isProductNavActive(pathname: string, href: string) {
  if (href === `${MODULE_BASE_PATH}/produtos`) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

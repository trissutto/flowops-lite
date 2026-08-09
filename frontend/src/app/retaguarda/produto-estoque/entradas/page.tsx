'use client';

import {
  Building2,
  PackagePlus,
  Printer,
  ScanBarcode,
  ShoppingCart,
} from 'lucide-react';
import ModuleHub, { type ModuleHubItem } from '@/features/produto-estoque/components/ModuleHub';

const items: ModuleHubItem[] = [
  {
    href: '/loja/pedidos-compra',
    label: 'Pedidos de Compra',
    subtitle: 'Nascimento do produto',
    description: 'Crie o pedido e cadastre automaticamente os novos produtos.',
    tone: 'rose',
    icon: ShoppingCart,
  },
  {
    href: '/loja/reposicao',
    label: 'Reposição',
    subtitle: 'Produto existente',
    description: 'Dê entrada em novas unidades de uma REF que já existe na loja.',
    tone: 'green',
    icon: PackagePlus,
  },
  {
    href: '/loja/etiquetas-avulsas',
    label: 'Etiquetas Avulsas',
    subtitle: 'Impressão',
    description: 'Encontre por REF ou SKU e imprima as etiquetas necessárias.',
    tone: 'amber',
    icon: Printer,
  },
  {
    href: '/retaguarda/cadastro-produtos',
    label: 'Cadastro Manual',
    subtitle: 'Novo SKU',
    description: 'Cadastre produtos fora do fluxo de pedido quando for necessário.',
    tone: 'purple',
    icon: ScanBarcode,
  },
  {
    href: '/retaguarda/fornecedores',
    label: 'Fornecedores',
    subtitle: 'Cadastro de apoio',
    description: 'Crie e edite os fornecedores usados nos pedidos de compra.',
    tone: 'teal',
    icon: Building2,
  },
];

export default function EntradasEtiquetasPage() {
  return (
    <ModuleHub
      eyebrow="Operação de entrada"
      title="Entradas & Etiquetas"
      description="Escolha como o produto entra no sistema. Produtos novos nascem no pedido de compra; reposições aumentam o estoque de produtos já cadastrados."
      note="Cada operação continua em seu fluxo especializado, com as mesmas regras e funções já usadas pelas lojas."
      items={items}
    />
  );
}

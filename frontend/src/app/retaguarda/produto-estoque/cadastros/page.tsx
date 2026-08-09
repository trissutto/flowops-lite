'use client';

import {
  Building2,
  FileCheck2,
  GalleryHorizontalEnd,
  PackagePlus,
  ScanLine,
  Shirt,
  Tags,
  UploadCloud,
} from 'lucide-react';
import ModuleHub, { type ModuleHubItem } from '@/features/produto-estoque/components/ModuleHub';

const items: ModuleHubItem[] = [
  {
    href: '/cadastros/classificacao-peca',
    label: 'Classificação da Peça',
    subtitle: 'Ocasião e modelagem',
    description: 'Gerencie ocasião, tecido, modelagem e coleção do produto.',
    tone: 'purple',
    icon: Shirt,
  },
  {
    href: '/retaguarda/produto-estoque/produtos/classificacao',
    label: 'BÁSICO / MODA',
    subtitle: 'Classificação comercial',
    description: 'Separe produtos básicos dos itens de moda sem sair do módulo.',
    tone: 'teal',
    icon: Tags,
  },
  {
    href: '/retaguarda/fornecedores',
    label: 'Fornecedores',
    subtitle: 'Cadastro',
    description: 'Crie e edite dados usados nos pedidos e nas fichas.',
    tone: 'green',
    icon: Building2,
  },
  {
    href: '/retaguarda/categorias',
    label: 'Categorias do Site',
    subtitle: 'Vitrine',
    description: 'Organize nome, imagem e ordem das categorias do e-commerce.',
    tone: 'rose',
    icon: GalleryHorizontalEnd,
  },
  {
    href: '/retaguarda/cadastro-produtos',
    label: 'Cadastro Manual',
    subtitle: 'Novo SKU',
    description: 'Crie um produto manualmente quando não nascer de um pedido.',
    tone: 'amber',
    icon: PackagePlus,
  },
  {
    href: '/retaguarda/publicar-site',
    label: 'Publicar no Site',
    subtitle: 'Publicação avançada',
    description: 'Acesse o fluxo especializado de envio e revisão do e-commerce.',
    tone: 'sky',
    icon: UploadCloud,
  },
  {
    href: '/auditoria-sku',
    label: 'Auditoria de SKU',
    subtitle: 'Integridade',
    description: 'Localize inconsistências de identificação dos produtos.',
    tone: 'slate',
    icon: ScanLine,
  },
  {
    href: '/retaguarda/auditoria-ncm',
    label: 'Auditoria de NCM',
    subtitle: 'Fiscal',
    description: 'Revise a classificação fiscal associada aos produtos.',
    tone: 'slate',
    icon: FileCheck2,
  },
];

export default function CadastrosAuxiliaresPage() {
  return (
    <ModuleHub
      eyebrow="Dados que completam a ficha"
      title="Cadastros auxiliares"
      description="Concentre as classificações e tabelas de apoio usadas no cadastro, na operação das lojas e na publicação do site."
      items={items}
    />
  );
}

'use client';

import {
  ArrowLeftRight,
  Boxes,
  PackageCheck,
  RefreshCcw,
  Route,
  Scale,
  Truck,
} from 'lucide-react';
import ModuleHub, { type ModuleHubItem } from '@/features/produto-estoque/components/ModuleHub';

const items: ModuleHubItem[] = [
  {
    href: '/retaguarda/realinhamento',
    label: 'Realinhamento',
    subtitle: 'Entre lojas',
    description: 'Analise e monte transferências para equilibrar o estoque da rede.',
    tone: 'orange',
    icon: Scale,
  },
  {
    href: '/retaguarda/produto-estoque/produtos',
    label: 'Grade por Loja',
    subtitle: 'Ficha Master',
    description: 'Clique na célula para ajustar estoque ou mover produtos entre lojas.',
    tone: 'teal',
    icon: Boxes,
  },
  // Conferir Estoque (Flow × Giga) saiu do hub (09/26): o MySQL do Giga foi desligado.
  {
    href: '/retaguarda/distribuicao-estoque',
    label: 'Distribuição',
    subtitle: 'Desequilíbrios',
    description: 'Detecte produtos concentrados ou faltando entre as lojas.',
    tone: 'rose',
    icon: ArrowLeftRight,
  },
  {
    href: '/retaguarda/remessas',
    label: 'Remessas',
    subtitle: 'Em trânsito',
    description: 'Acompanhe caixas, rotas e comprovantes de transferência.',
    tone: 'sky',
    icon: Truck,
  },
  {
    href: '/retaguarda/estoque',
    label: 'Espelho de Estoque',
    subtitle: 'Consulta operacional',
    description: 'Consulte a posição de estoque mantida pela retaguarda.',
    tone: 'slate',
    icon: PackageCheck,
  },
  {
    href: '/retaguarda/reconciliar-estoque',
    label: 'Reconciliar',
    subtitle: 'Correção retroativa',
    description: 'Reconcilie baixas de estoque do PDV com segurança.',
    tone: 'rose',
    icon: RefreshCcw,
  },
  {
    href: '/retaguarda/reprocessar-estoque',
    label: 'Reprocessar Remessas',
    subtitle: 'Correção técnica',
    description: 'Ajuste baixas do ERP relacionadas a remessas com inconsistência.',
    tone: 'slate',
    icon: Route,
  },
];

export default function EstoqueMovimentacoesPage() {
  return (
    <ModuleHub
      eyebrow="Controle físico da rede"
      title="Estoque & Movimentações"
      description="Ajuste a grade diretamente na ficha Master, transfira entre lojas e use os fluxos de conferência ou correção quando houver divergências."
      note="Ajustes e transferências continuam registrando suas movimentações pelos serviços atuais; esta tela apenas organiza os pontos de entrada."
      items={items}
    />
  );
}

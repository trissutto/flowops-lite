import {
  BarChart3, Globe2, Home, Package, ReceiptText, Settings,
  ShoppingBag, Store, Tags, Users, WalletCards,
} from 'lucide-react';

export type BetaNavItem = { label: string; href: string; legacy?: boolean };
export type BetaNavGroup = {
  key: string;
  label: string;
  href?: string;
  icon: typeof Home;
  items?: BetaNavItem[];
};

export const BETA_NAV: BetaNavGroup[] = [
  { key: 'inicio', label: 'Início', href: '/beta', icon: Home },
  { key: 'clientes', label: 'Clientes', icon: Users, items: [
    { label: 'Lista de clientes', href: '/beta/clientes' },
    { label: 'Cadastrar cliente', href: '/clientes-crm?new=1', legacy: true },
    { label: 'Revisão de identidade', href: '/retaguarda/revisao-identidade', legacy: true },
  ]},
  { key: 'produtos', label: 'Produtos', icon: Package, items: [
    { label: 'Consulta / edição', href: '/produtos', legacy: true },
    { label: 'Estoque e movimentações', href: '/retaguarda/estoque', legacy: true },
    { label: 'Cadastro de produtos', href: '/retaguarda/cadastro-produtos', legacy: true },
  ]},
  { key: 'site', label: 'Site', icon: Globe2, items: [
    { label: 'Painel do site', href: '/site', legacy: true },
    { label: 'Pedidos online', href: '/separacao', legacy: true },
    { label: 'Produtos publicados', href: '/retaguarda/publicar-site', legacy: true },
  ]},
  { key: 'rh', label: 'Recursos Humanos', icon: Users, items: [
    { label: 'Colaboradores', href: '/retaguarda/rh', legacy: true },
    { label: 'Ponto e jornada', href: '/retaguarda/rh/espelho-ponto', legacy: true },
    { label: 'Folha e pagamentos', href: '/retaguarda/rh', legacy: true },
  ]},
  { key: 'financeiro', label: 'Financeiro', icon: WalletCards, items: [
    { label: 'Contas a pagar', href: '/financeiro', legacy: true },
    { label: 'Fluxo de caixa', href: '/retaguarda/super-painel-caixas', legacy: true },
    { label: 'Relatórios', href: '/financeiro', legacy: true },
  ]},
  { key: 'vendas', label: 'Vendas', icon: BarChart3, items: [
    { label: 'Faturamento das lojas', href: '/retaguarda/faturamento', legacy: true },
    { label: 'Indicadores e ranking', href: '/retaguarda/faturamento', legacy: true },
    { label: 'Metas', href: '/retaguarda/metas', legacy: true },
  ]},
  { key: 'fiscal', label: 'Fiscal', icon: ReceiptText, items: [
    { label: 'Notas fiscais', href: '/retaguarda/nfe-envio', legacy: true },
    { label: 'Relatórios fiscais', href: '/retaguarda/relatorio-fiscal', legacy: true },
  ]},
  { key: 'lojas', label: 'Lojas', icon: Store, items: [
    { label: 'Painel por loja', href: '/lojas', legacy: true },
    { label: 'Estoque por loja', href: '/franquias/estoque', legacy: true },
    { label: 'Transferências', href: '/retaguarda/transferencias-report', legacy: true },
  ]},
  { key: 'configuracoes', label: 'Configurações', icon: Settings, items: [
    { label: 'Rede e lojas', href: '/configuracoes', legacy: true },
    { label: 'Usuários e permissões', href: '/usuarios', legacy: true },
    { label: 'Integrações e auditoria', href: '/retaguarda/integracoes', legacy: true },
  ]},
];

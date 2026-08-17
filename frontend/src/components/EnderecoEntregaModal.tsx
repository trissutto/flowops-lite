'use client';

import { useState } from 'react';
import { api } from '@/lib/api';

/**
 * CORRIGIR O ENDEREÇO DE ENTREGA de um pedido, antes de postar.
 *
 * Existe porque o endereço do pedido é um SNAPSHOT gravado no checkout e a
 * etiqueta lê dele: a operadora via o complemento errado na hora da postagem e
 * não tinha o que clicar — corrigir o cadastro do cliente não mudava o pedido.
 *
 * UM componente pras DUAS telas (loja e retaguarda). Duplicar o formulário
 * garantiria que um dia eles divergiriam — e endereço divergente é peça no
 * lugar errado.
 *
 * O complemento vem separado do bairro. Pedido antigo gravou os dois juntos no
 * `address_2` ("Apto 42 - Centro"); o backend desempacota e devolve certo, e o
 * que for salvo aqui já grava em campos próprios.
 */

export interface EnderecoEntrega {
  /** Nome da destinatária — vai pra etiqueta e pro pedido (17/08: ON-000009 saiu "Cliente"). */
  nome?: string | null;
  cep?: string | null;
  endereco?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
}

/** Lê o JSON do pedido no shape do WooCommerce (o mesmo que a etiqueta lê). */
export function enderecoDoPedido(shippingAddressJson: string | null | undefined): EnderecoEntrega {
  let a: any = {};
  try { a = JSON.parse(shippingAddressJson || '{}'); } catch { /* snapshot cru */ }

  // Mesma regra do backend (common/endereco-wc.ts): sem `neighborhood`, o
  // address_2 antigo carrega "complemento - bairro" e o último pedaço é o
  // bairro. Sem separador, é tudo complemento — inventar bairro seria chutar.
  const bairroProprio = String(a.neighborhood ?? a.bairro ?? '').trim();
  const bruto = String(a.address_2 ?? '').trim();
  let complemento = bruto;
  let bairro = bairroProprio;
  if (!bairroProprio && bruto.includes(' - ')) {
    const p = bruto.split(' - ');
    bairro = (p.pop() || '').trim();
    complemento = p.join(' - ').trim();
  }

  // `address_1` é "rua, número" grudado; `number` é o campo confiável quando existe.
  const a1 = String(a.address_1 ?? '').trim();
  let endereco = a1;
  let numero = String(a.number ?? '').trim();
  if (!numero && a1) {
    const m = a1.match(/^(.*?),?\s*(\d+[A-Za-z]?)\s*$/);
    if (m) { endereco = m[1].trim(); numero = m[2]; }
  } else if (numero && a1.endsWith(numero)) {
    endereco = a1.slice(0, a1.length - numero.length).replace(/,\s*$/, '').trim();
  }

  return {
    nome: [a.first_name, a.last_name].map((s) => String(s ?? '').trim()).filter(Boolean).join(' '),
    cep: String(a.postcode ?? '').trim(),
    endereco, numero, complemento, bairro,
    cidade: String(a.city ?? '').trim(),
    uf: String(a.state ?? '').trim(),
  };
}

export default function EnderecoEntregaModal({
  wcOrderId, inicial, onFechar, onSalvo,
}: {
  wcOrderId: number;
  inicial: EnderecoEntrega;
  onFechar: () => void;
  /** Recebe o shipping novo — a tela recarrega o pedido com o endereço já certo. */
  onSalvo: (shipping: any) => void;
}) {
  const [f, setF] = useState<EnderecoEntrega>({
    nome: inicial.nome ?? '',
    cep: inicial.cep ?? '', endereco: inicial.endereco ?? '', numero: inicial.numero ?? '',
    complemento: inicial.complemento ?? '', bairro: inicial.bairro ?? '',
    cidade: inicial.cidade ?? '', uf: inicial.uf ?? '',
  });
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const set = (k: keyof EnderecoEntrega) => ({
    value: String(f[k] ?? ''),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setF((atual) => ({ ...atual, [k]: e.target.value })),
  });

  async function buscarCep(v: string) {
    const cep = v.replace(/\D/g, '');
    if (cep.length !== 8) return;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const d = await r.json();
      if (d?.erro) return;
      // Só preenche o que está VAZIO: o CEP não pode apagar a correção que a
      // pessoa acabou de digitar.
      setF((atual) => ({
        ...atual,
        endereco: atual.endereco || d.logradouro || '',
        bairro: atual.bairro || d.bairro || '',
        cidade: atual.cidade || d.localidade || '',
        uf: atual.uf || String(d.uf || '').toUpperCase(),
      }));
    } catch { /* ViaCEP fora — segue com o digitado */ }
  }

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const r = await api<any>(`/orders/wc/${wcOrderId}/endereco-entrega`, {
        method: 'PATCH',
        body: JSON.stringify(f),
      });
      onSalvo(r?.shipping ?? null);
      onFechar();
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui salvar');
      setSalvando(false);
    }
  }

  const campo = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-500';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-800">Corrigir endereço de entrega</h3>
          <button onClick={onFechar} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Vale pra ETIQUETA deste pedido e atualiza o cadastro da cliente.
        </p>

        {erro && <div className="mb-3 rounded bg-rose-50 px-3 py-2 text-xs text-rose-800">{erro}</div>}

        <div className="space-y-2.5">
          <div>
            <label className="text-[11px] uppercase tracking-wide text-slate-400">Nome da destinatária</label>
            <input {...set('nome')} placeholder="Nome completo, como vai na etiqueta" className={campo} />
            {!String(f.nome ?? '').trim() && (
              <p className="mt-1 text-[11px] text-rose-700">Sem nome a etiqueta sai como &quot;Cliente&quot;.</p>
            )}
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-slate-400">CEP</label>
            <input {...set('cep')} onBlur={(e) => void buscarCep(e.target.value)} className={campo} />
          </div>
          <div className="grid grid-cols-[1fr_90px] gap-2">
            <div>
              <label className="text-[11px] uppercase tracking-wide text-slate-400">Rua</label>
              <input {...set('endereco')} className={campo} />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-slate-400">Número</label>
              <input {...set('numero')} className={campo} />
            </div>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-slate-400">Complemento</label>
            <input {...set('complemento')} placeholder="Apto, bloco, fundos…" className={campo} />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-slate-400">Bairro</label>
            <input {...set('bairro')} className={campo} />
          </div>
          <div className="grid grid-cols-[1fr_70px] gap-2">
            <div>
              <label className="text-[11px] uppercase tracking-wide text-slate-400">Cidade</label>
              <input {...set('cidade')} className={campo} />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-slate-400">UF</label>
              <input {...set('uf')} maxLength={2} className={campo} />
            </div>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button onClick={onFechar} className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">
            Cancelar
          </button>
          <button
            onClick={() => void salvar()}
            disabled={salvando}
            className="flex-1 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-black text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {salvando ? 'Salvando…' : 'Salvar endereço'}
          </button>
        </div>

        <p className="mt-3 text-[11px] leading-snug text-amber-800">
          Se a etiqueta já saiu com o endereço antigo, use <b>Refazer envio</b> depois de
          salvar — a etiqueta velha é cancelada e sai outra com o endereço novo.
        </p>
      </div>
    </div>
  );
}

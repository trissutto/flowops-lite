'use client';
import Link from 'next/link';
import { ArrowLeft, MapPin } from 'lucide-react';
import BottomNav from '@/components/BottomNav';

const LOJAS = [
  { code: '01', nome: 'Itanhaém',      cidade: 'Itanhaém — SP' },
  { code: '02', nome: 'Santos',        cidade: 'Santos — SP' },
  { code: '03', nome: 'Vinhedo',       cidade: 'Vinhedo — SP' },
  { code: '04', nome: 'Indaiatuba',    cidade: 'Indaiatuba — SP' },
  { code: '05', nome: 'Piracicaba',    cidade: 'Piracicaba — SP' },
  { code: '06', nome: 'Sorocaba',      cidade: 'Sorocaba — SP' },
  { code: '07', nome: 'Campinas',      cidade: 'Campinas — SP' },
  { code: '09', nome: 'Santos 2',      cidade: 'Santos — SP' },
  { code: '10', nome: 'Jundiaí',       cidade: 'Jundiaí — SP' },
  { code: '11', nome: 'Limeira',       cidade: 'Limeira — SP' },
  { code: '14', nome: 'Praia Grande',  cidade: 'Praia Grande — SP' },
  { code: '15', nome: 'Moema',         cidade: 'São Paulo — SP' },
  { code: '18', nome: 'Mogi',          cidade: 'Mogi — SP' },
  { code: '19', nome: 'Itu',           cidade: 'Itu — SP' },
];

export default function LojasPage() {
  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Nossas lojas</h1>
      </header>
      <p className="px-5 mt-3 text-sm text-cream/60">
        {LOJAS.length} lojas Lurd's Plus Size no estado de São Paulo
      </p>
      <div className="mt-5 px-5 space-y-2">
        {LOJAS.map((l) => (
          <div key={l.code} className="card-dark flex items-center gap-3">
            <MapPin className="w-5 h-5 text-gold/70 shrink-0" />
            <div className="flex-1">
              <div className="font-bold">{l.nome}</div>
              <div className="text-xs text-cream/60">{l.cidade}</div>
            </div>
            <span className="text-[10px] font-mono text-cream/40">#{l.code}</span>
          </div>
        ))}
      </div>
      <div className="h-20" />
      <BottomNav />
    </div>
  );
}

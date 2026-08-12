import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * LEADS DO SITE — nome, celular e e-mail trocados por um cupom de 10%.
 *
 * O popup da vitrine é a única porta que grava aqui. A regra de negócio é
 * curta e vale a pena estar num lugar só:
 *
 *   · TELEFONE é a identidade (mesma escolha do CRM). Cadastro repetido
 *     ATUALIZA a linha e mantém o cupom e a data original — cupom que muda a
 *     cada visita ensina a cliente a não confiar no primeiro.
 *   · Nada disso vira cliente do CRM. Lead é quem ainda não comprou; quando
 *     comprar, o pedido cria o cadastro pelos caminhos que já existem.
 *   · Validação é de PORTA, não de formulário: o site já valida na tela, mas
 *     endpoint público sem token recebe o que a internet mandar.
 */

export interface LeadInput {
  nome?: string;
  telefone?: string;
  email?: string;
  origem?: string;
  /** Campo-armadilha do formulário — humano nunca preenche. Ver o controller. */
  sobrenome?: string;
}

/** Cupom entregue pelo popup. Env pra trocar de campanha sem deploy. */
export const CUPOM_PRIMEIRA_COMPRA = process.env.CUPOM_LEAD_SITE || 'PRIMEIRA10';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

@Injectable()
export class SiteLeadsService {
  private readonly logger = new Logger(SiteLeadsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private soDigitos(v: unknown) {
    return String(v ?? '').replace(/\D/g, '');
  }

  /**
   * Celular brasileiro: 10 ou 11 dígitos com DDD válido. Aceita o 55 na
   * frente (quem cola do WhatsApp manda assim) e descarta.
   */
  private telefoneValido(bruto: string): string | null {
    let d = bruto;
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    if (d.length < 10 || d.length > 11) return null;
    if (Number(d.slice(0, 2)) < 11) return null; // DDD não existe abaixo de 11
    // Número repetido ("11999999999") é teste ou robô, não cliente.
    if (/^(\d)\1+$/.test(d.slice(2))) return null;
    return d;
  }

  async registrar(input: LeadInput) {
    const nome = String(input.nome ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const email = String(input.email ?? '').trim().toLowerCase().slice(0, 160);
    const telefone = this.telefoneValido(this.soDigitos(input.telefone));

    if (nome.length < 2) throw new BadRequestException('Informe seu nome');
    if (!telefone) throw new BadRequestException('Confira o celular com DDD');
    if (!EMAIL.test(email)) throw new BadRequestException('Confira o e-mail digitado');

    const origem = String(input.origem ?? '').trim().slice(0, 200) || null;

    /**
     * `update` sem tocar em `cupom` nem em `createdAt`: a segunda visita
     * corrige nome/e-mail, não renegocia a oferta.
     */
    const lead = await (this.prisma as any).siteLead.upsert({
      where: { telefone },
      create: { nome, telefone, email, origem, cupom: CUPOM_PRIMEIRA_COMPRA },
      update: { nome, email, ...(origem ? { origem } : {}) },
    });

    this.logger.log(`[leads] ${nome} (${telefone}) — cupom ${lead.cupom} · origem ${origem ?? '-'}`);
    return { ok: true, cupom: lead.cupom };
  }

  /** Lista da retaguarda — recorte por data, como toda tela com tempo. */
  async listar(params: { de?: string; ate?: string; busca?: string; limite?: number }) {
    const where: any = {};

    const de = this.dia(params.de);
    const ate = this.dia(params.ate);
    if (de || ate) {
      where.createdAt = {};
      if (de) where.createdAt.gte = de;
      // `ate` é o dia INTEIRO: quem filtra "até hoje" quer o que entrou hoje
      // de manhã, não só o que entrou à meia-noite.
      if (ate) where.createdAt.lte = new Date(ate.getTime() + 24 * 60 * 60 * 1000 - 1);
    }

    const busca = String(params.busca ?? '').trim();
    if (busca) {
      const digitos = this.soDigitos(busca);
      where.OR = [
        { nome: { contains: busca, mode: 'insensitive' } },
        { email: { contains: busca, mode: 'insensitive' } },
        ...(digitos.length >= 3 ? [{ telefone: { contains: digitos } }] : []),
      ];
    }

    const limite = Math.min(2000, Math.max(1, Number(params.limite) || 500));
    const [itens, total] = await Promise.all([
      (this.prisma as any).siteLead.findMany({
        where, orderBy: { createdAt: 'desc' }, take: limite,
      }),
      (this.prisma as any).siteLead.count({ where }),
    ]);
    return { itens, total, limite };
  }

  private dia(v?: string): Date | null {
    if (!v) return null;
    const d = new Date(`${String(v).slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}

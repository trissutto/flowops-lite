import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { CorreiosAuthService } from './correios-auth.service';

/**
 * Serviços dos Correios (API CWS) — cálculo de frete (preço + prazo) e
 * pré-postagem (gera o código de rastreio + insumo pra etiqueta).
 *
 * Códigos de serviço (coProduto) vêm do CONTRATO. Defaults comuns COM contrato:
 *   PAC   = 03298   ·  SEDEX = 03220
 * Override via env CORREIOS_SERVICO_PAC / CORREIOS_SERVICO_SEDEX.
 */
@Injectable()
export class CorreiosService {
  private readonly logger = new Logger(CorreiosService.name);
  constructor(private readonly auth: CorreiosAuthService) {}

  private get servicos(): Array<{ nome: 'PAC' | 'SEDEX'; codigo: string }> {
    return [
      { nome: 'PAC', codigo: String(process.env.CORREIOS_SERVICO_PAC || '03298').trim() },
      { nome: 'SEDEX', codigo: String(process.env.CORREIOS_SERVICO_SEDEX || '03220').trim() },
    ];
  }

  status() {
    return {
      configurado: this.auth.configured,
      ambiente: process.env.CORREIOS_AMBIENTE === 'hom' ? 'homologação' : 'produção',
      usuario: this.auth.usuario || null,
      cartaoPostagem: this.auth.cartaoPostagem ? '••••' + this.auth.cartaoPostagem.slice(-4) : null,
      contrato: this.auth.contrato || null,
      dr: this.auth.dr,
      cepOrigem: this.auth.cepOrigem || null,
      servicos: this.servicos,
    };
  }

  /**
   * Calcula PREÇO + PRAZO por CEP destino pros serviços (PAC/SEDEX). Peso em
   * GRAMAS; dimensões em cm. Retorna uma opção por serviço.
   */
  async calcularFrete(input: {
    cepDestino: string;
    pesoGramas?: number;
    comprimento?: number;
    largura?: number;
    altura?: number;
  }) {
    const cepDestino = String(input.cepDestino || '').replace(/\D/g, '');
    const cepOrigem = this.auth.cepOrigem;
    if (cepDestino.length !== 8) throw new BadRequestException('CEP destino inválido (8 dígitos).');
    if (cepOrigem.length !== 8) throw new BadRequestException('CEP de origem não configurado (CORREIOS_CEP_ORIGEM).');

    // Defaults de embalagem de vestuário (caixa pequena) — ajustáveis por env.
    const peso = Math.max(300, Number(input.pesoGramas) || Number(process.env.CORREIOS_PESO_PADRAO_G ?? 500));
    const comprimento = Number(input.comprimento) || 20;
    const largura = Number(input.largura) || 20;
    const altura = Number(input.altura) || 10;

    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;
    const opcoes: Array<{ servico: string; codigo: string; precoReais: number | null; prazoDias: number | null; erro?: string }> = [];

    for (const s of this.servicos) {
      let precoReais: number | null = null;
      let prazoDias: number | null = null;
      let erro: string | undefined;
      try {
        const qs =
          `?cepOrigem=${cepOrigem}&cepDestino=${cepDestino}&psObjeto=${peso}` +
          `&tpObjeto=2&comprimento=${comprimento}&largura=${largura}&altura=${altura}` +
          `&nuContrato=${this.auth.contrato}&nuDR=${this.auth.dr}`;
        const [preco, prazo] = await Promise.all([
          axios.get(`${base}/preco/v1/nacional/${s.codigo}${qs}`, { headers, timeout: 20000, validateStatus: () => true }),
          axios.get(`${base}/prazo/v1/nacional/${s.codigo}?cepOrigem=${cepOrigem}&cepDestino=${cepDestino}`, { headers, timeout: 20000, validateStatus: () => true }),
        ]);
        if (preco.status >= 200 && preco.status < 300) {
          const pc = preco.data?.pcFinal ?? preco.data?.pcBase ?? null;
          precoReais = pc != null ? Number(String(pc).replace('.', '').replace(',', '.')) : null;
        } else {
          erro = preco.data?.msgs?.join('; ') || `preço HTTP ${preco.status}`;
        }
        if (prazo.status >= 200 && prazo.status < 300) {
          prazoDias = prazo.data?.prazoEntrega != null ? Number(prazo.data.prazoEntrega) : null;
        }
      } catch (e: any) {
        erro = e?.message || 'falha';
      }
      opcoes.push({ servico: s.nome, codigo: s.codigo, precoReais, prazoDias, erro });
    }
    return { cepOrigem, cepDestino, pesoGramas: peso, opcoes };
  }

  /**
   * Cria a PRÉ-POSTAGEM de um envio → retorna o código de rastreio (codigoObjeto)
   * e o id da pré-postagem (usado pra baixar a etiqueta). O ESQUELETO segue a
   * doc da API CWS; confirmar os campos exatos com o contrato ao testar.
   */
  async criarPrepostagem(input: {
    servico: 'PAC' | 'SEDEX';
    remetente: { nome: string; cnpjCpf: string; endereco: string; numero: string; bairro: string; cidade: string; uf: string; cep: string; telefone?: string };
    destinatario: { nome: string; cpfCnpj?: string; endereco: string; numero: string; complemento?: string; bairro: string; cidade: string; uf: string; cep: string; telefone?: string };
    pesoGramas: number;
    comprimento?: number; largura?: number; altura?: number;
    nfeChave?: string; // chave da NF-e que acompanha (opcional mas recomendado)
    valorDeclarado?: number;
  }) {
    const codigo = this.servicos.find((s) => s.nome === input.servico)?.codigo;
    if (!codigo) throw new BadRequestException(`Serviço inválido: ${input.servico}`);
    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;

    const body: any = {
      idCorreios: '',
      remetente: {
        nome: input.remetente.nome.slice(0, 50),
        cpfCnpj: input.remetente.cnpjCpf.replace(/\D/g, ''),
        endereco: { logradouro: input.remetente.endereco, numero: input.remetente.numero, bairro: input.remetente.bairro, cidade: input.remetente.cidade, uf: input.remetente.uf, cep: input.remetente.cep.replace(/\D/g, '') },
        telefone: (input.remetente.telefone || '').replace(/\D/g, ''),
      },
      destinatario: {
        nome: input.destinatario.nome.slice(0, 50),
        ...(input.destinatario.cpfCnpj ? { cpfCnpj: input.destinatario.cpfCnpj.replace(/\D/g, '') } : {}),
        endereco: { logradouro: input.destinatario.endereco, numero: input.destinatario.numero, complemento: input.destinatario.complemento || '', bairro: input.destinatario.bairro, cidade: input.destinatario.cidade, uf: input.destinatario.uf, cep: input.destinatario.cep.replace(/\D/g, '') },
        telefone: (input.destinatario.telefone || '').replace(/\D/g, ''),
      },
      codigoServico: codigo,
      cartaoPostagem: this.auth.cartaoPostagem,
      peso: String(Math.max(1, Math.round(input.pesoGramas))),
      codigoFormatoObjetoInformado: '2', // 2 = pacote/caixa
      dimensao: {
        tipoObjeto: '002',
        dimensaoAltura: String(input.altura || 10),
        dimensaoLargura: String(input.largura || 20),
        dimensaoComprimento: String(input.comprimento || 20),
      },
      ...(input.nfeChave ? { chaveNFe: input.nfeChave.replace(/\D/g, '') } : {}),
      ...(input.valorDeclarado ? { listaServicoAdicional: [{ codigoServicoAdicional: '019', valorDeclarado: input.valorDeclarado.toFixed(2) }] } : {}),
    };

    try {
      const resp = await axios.post(`${base}/prepostagem/v1/prepostagens`, body, { headers, timeout: 30000, validateStatus: () => true });
      if (resp.status < 200 || resp.status >= 300) {
        const msg = resp.data?.msgs?.join('; ') || resp.data?.message || `HTTP ${resp.status}`;
        throw new BadRequestException(`Correios recusou a pré-postagem: ${msg}`);
      }
      return {
        ok: true,
        idPrepostagem: resp.data?.id ?? resp.data?.idPrePostagem ?? null,
        codigoRastreio: resp.data?.codigoObjeto ?? resp.data?.codigoRastreio ?? null,
        raw: resp.data,
      };
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`Falha ao criar pré-postagem: ${e?.message || e}`);
    }
  }
}

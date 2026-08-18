import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { CorreiosAuthService } from './correios-auth.service';
import { encurtarCampoEndereco, encurtarNomeDestinatario, LIMITES_TRANSPORTE } from '../lib/nome-destinatario';

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

  /** Busca endereço por CEP (ViaCEP) — autopreenche remetente/destinatário. */
  async buscarCep(cepRaw: string) {
    const cep = String(cepRaw || '').replace(/\D/g, '');
    if (cep.length !== 8) throw new BadRequestException('CEP inválido (8 dígitos).');
    try {
      const r = await axios.get(`https://viacep.com.br/ws/${cep}/json/`, { timeout: 8000, validateStatus: () => true });
      if (r.status >= 200 && r.status < 300 && r.data && !r.data.erro) {
        return {
          cep,
          logradouro: r.data.logradouro || '',
          bairro: r.data.bairro || '',
          cidade: r.data.localidade || '',
          uf: r.data.uf || '',
          // código IBGE do município — a NF-e do envio precisa (cMun do dest)
          ibge: String(r.data.ibge || '').replace(/\D/g, ''),
        };
      }
      return { erro: 'CEP não encontrado' };
    } catch (e: any) {
      return { erro: e?.message || 'falha ao buscar CEP' };
    }
  }

  /**
   * DEBUG PRC-124: autentica, decodifica o JWT devolvido pelos Correios e mostra
   * a QUE contrato/DR/cartão o token está amarrado — pra comparar com o que a
   * gente MANDA no cálculo de frete. Se o contrato/DR do token != o enviado, é
   * a causa do PRC-124. NÃO devolve o token cru (só os claims dele).
   */
  async tokenDebug() {
    const token = await this.auth.getToken();
    let claims: any = null;
    try {
      const parts = token.split('.');
      if (parts.length >= 2) {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        claims = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      }
    } catch { /* token não é JWT decodificável */ }
    return {
      enviamosNoFrete: {
        contrato: this.auth.contrato,
        dr: this.auth.dr,
        cartaoPostagem: this.auth.cartaoPostagem,
      },
      tokenPertenceA: claims ?? '(o token não é um JWT decodificável)',
    };
  }

  /**
   * Remetente PADRÃO (matriz) — configurável por env. Usado pelo envio da live
   * enquanto não há endereço de remetente por loja no banco. Defaults = matriz
   * Itanhaém (T O RISSUTTO EIRELI).
   */
  remetentePadrao() {
    const g = (k: string, d: string) => String(process.env[k] || d).trim();
    return {
      nome: g('CORREIOS_REMETENTE_NOME', 'T O RISSUTTO EIRELI'),
      cnpjCpf: g('CORREIOS_REMETENTE_CNPJCPF', '20104813000139'),
      endereco: g('CORREIOS_REMETENTE_ENDERECO', 'Av Harry Forssell'),
      numero: g('CORREIOS_REMETENTE_NUMERO', '159'),
      bairro: g('CORREIOS_REMETENTE_BAIRRO', 'Belas Artes'),
      cidade: g('CORREIOS_REMETENTE_CIDADE', 'Itanhaém'),
      uf: g('CORREIOS_REMETENTE_UF', 'SP'),
      cep: g('CORREIOS_REMETENTE_CEP', this.auth.cepOrigem || '11746692'),
      telefone: g('CORREIOS_REMETENTE_TELEFONE', ''),
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
    // Parser robusto: aceita "15,45" (BR), "1.234,56" (BR c/ milhar) e 15.45 (número).
    const parseBRL = (v: any): number | null => {
      if (v == null) return null;
      const s = String(v).trim();
      if (!s) return null;
      return s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
    };

    /**
     * PAC e SEDEX EM PARALELO (17/08). Era `for…await` — SEDEX só começava
     * quando o PAC terminava, e cada um leva ~2,5 s: a cotação inteira dava
     * ~5 s no dia bom e estourava os 9 s do BFF do site no dia ruim (a cliente
     * caía na tabela local, sem a promoção). Um serviço nunca depende do outro,
     * e o try/catch por serviço garante que a promessa de cada um NUNCA
     * rejeita — falha vira `erro` na própria opção. Ordem de saída segue a de
     * `this.servicos` (PAC, SEDEX), igual antes.
     */
    const opcoes: Array<{
      servico: string; codigo: string;
      precoReais: number | null; precoComSeguro: number | null; prazoDias: number | null;
      erro?: string; raw?: any;
    }> = await Promise.all(this.servicos.map(async (s) => {
      let precoReais: number | null = null;
      let precoComSeguro: number | null = null;
      let prazoDias: number | null = null;
      let erro: string | undefined;
      let raw: any = null;
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
          raw = preco.data; // resposta crua — pra conferir desconto de contrato/tabela promocional
          /**
           * 🔴 O PREÇO É O `pcFinal` (13/08). Era `pcBase`, e `pcBase` NÃO é a
           * conta: é a tarifa do serviço antes dos adicionais que os Correios
           * cobram junto (seguro automático/ad valorem e afins). A diferença
           * apareceu num pedido real — SEDEX pra SC saiu **R$ 9,94** no
           * checkout, mais barato que o PAC de R$ 19,99 da mesma cotação, e a
           * cliente naturalmente escolheu o expresso.
           *
           * `pcFinal` é o que a fatura vai cobrar da loja. Cobrar menos que
           * isso é vender frete no prejuízo, em silêncio, em toda UF que não
           * tem tabela promocional.
           */
          precoReais = parseBRL(preco.data?.pcFinal ?? preco.data?.pcBase);
          precoComSeguro = parseBRL(preco.data?.pcFinal);
          const base = parseBRL(preco.data?.pcBase);
          const cheia = parseBRL(preco.data?.pcBaseGeral);
          this.logger.log(
            `[frete] ${s.nome} ${cepOrigem}→${cepDestino} ${peso}g ${comprimento}x${largura}x${altura}cm: ` +
              `cobrado=${precoReais} pcBase=${base} pcBaseGeral=${cheia} pcFinal=${precoComSeguro}`,
          );
        } else {
          raw = preco.data;
          erro = preco.data?.msgs?.join('; ') || `preço HTTP ${preco.status}`;
        }
        if (prazo.status >= 200 && prazo.status < 300) {
          prazoDias = prazo.data?.prazoEntrega != null ? Number(prazo.data.prazoEntrega) : null;
        }
      } catch (e: any) {
        erro = e?.message || 'falha';
      }
      return { servico: s.nome, codigo: s.codigo, precoReais, precoComSeguro, prazoDias, erro, raw };
    }));
    // Dimensões junto: preço estranho quase sempre é caixa errada, e a tela
    // precisa mostrar o que FOI enviado, não o que se supõe ter sido.
    return { cepOrigem, cepDestino, pesoGramas: peso, comprimento, largura, altura, opcoes };
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
    itensDeclaracao?: Array<{ conteudo: string; quantidade?: string | number; valor?: number }>;
  }) {
    const codigo = this.servicos.find((s) => s.nome === input.servico)?.codigo;
    if (!codigo) throw new BadRequestException(`Serviço inválido: ${input.servico}`);
    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;

    // Telefone CWS quer DDD e número separados — e o Correios VALIDA o
    // celular (DDD + 9 dígitos). Formato quebrado (8 díg, +55, fixo) TRAVA a
    // pré-postagem inteira (29/07) → só manda quando é celular VÁLIDO;
    // senão OMITE o campo (é opcional — melhor sem celular do que sem etiqueta).
    const splitFone = (tel?: string) => {
      let d = (tel || '').replace(/\D/g, '');
      if ((d.length === 13 || d.length === 12) && d.startsWith('55')) d = d.slice(2); // +55
      if (d.length === 10 && d[2] >= '6') d = `${d.slice(0, 2)}9${d.slice(2)}`; // celular antigo sem o 9
      if (d.length === 11 && d[2] === '9') return { ddd: d.slice(0, 2), numero: d.slice(2) };
      return { ddd: '', numero: '' }; // inválido/fixo → não manda
    };
    const foneRem = splitFone(input.remetente.telefone);
    const foneDest = splitFone(input.destinatario.telefone);

    // LIMITE ÚNICO pra todos os campos e provedores (dono 06/08: "melhor
    // limitar todos pelo Mais Envios") — ver LIMITES_TRANSPORTE. Abreviação
    // antes do corte ("Avenida Doutor"→"Av. Dr.") — e fica no log quando mexeu.
    const L = LIMITES_TRANSPORTE;
    const endLimite = (rotulo: string, v: any, max: number) => {
      const original = String(v || '').replace(/\s+/g, ' ').trim();
      const curto = encurtarCampoEndereco(original, max);
      if (curto !== original) {
        this.logger.warn(`[correios] ${rotulo} encurtado pro limite de ${max}: "${original}" → "${curto}"`);
      }
      return curto;
    };

    const body: any = {
      remetente: {
        nome: encurtarNomeDestinatario(input.remetente.nome, L.nome),
        cpfCnpj: input.remetente.cnpjCpf.replace(/\D/g, ''),
        ...(foneRem.numero ? { dddCelular: foneRem.ddd, celular: foneRem.numero } : {}),
        endereco: {
          cep: input.remetente.cep.replace(/\D/g, ''),
          logradouro: endLimite('logradouro remetente', input.remetente.endereco, L.logradouro),
          numero: String(input.remetente.numero || 'S/N').trim().slice(0, L.numero),
          bairro: endLimite('bairro remetente', input.remetente.bairro, L.bairro),
          cidade: endLimite('cidade remetente', input.remetente.cidade, L.cidade),
          uf: input.remetente.uf,
        },
      },
      destinatario: {
        // Nome abrevia preservando primeiro nome e último sobrenome — cortar
        // seco deixava a etiqueta com nome partido ("...Marques da Sil").
        nome: encurtarNomeDestinatario(input.destinatario.nome, L.nome),
        ...(input.destinatario.cpfCnpj ? { cpfCnpj: input.destinatario.cpfCnpj.replace(/\D/g, '') } : {}),
        ...(foneDest.numero ? { dddCelular: foneDest.ddd, celular: foneDest.numero } : {}),
        endereco: {
          cep: input.destinatario.cep.replace(/\D/g, ''),
          logradouro: endLimite('logradouro destinatário', input.destinatario.endereco, L.logradouro),
          numero: String(input.destinatario.numero || 'S/N').trim().slice(0, L.numero),
          complemento: endLimite('complemento destinatário', input.destinatario.complemento || '', L.complemento),
          bairro: endLimite('bairro destinatário', input.destinatario.bairro, L.bairro),
          cidade: endLimite('cidade destinatário', input.destinatario.cidade, L.cidade),
          uf: input.destinatario.uf,
        },
      },
      codigoServico: codigo,
      cartaoPostagem: this.auth.cartaoPostagem,
      // ── Peso e dimensões no formato do CWS (nomes "*Informado"). ──
      pesoInformado: String(Math.max(1, Math.round(input.pesoGramas))),        // PPN peso
      codigoFormatoObjetoInformado: '2',                                        // 2 = pacote/caixa
      alturaInformada: String(input.altura || 10),
      larguraInformada: String(input.largura || 20),
      comprimentoInformado: String(input.comprimento || 20),                    // PPN-046
      diametroInformado: '0',
      // ── Ciência de que o objeto não é proibido (PPN-330). ──
      cienteObjetoNaoProibido: 1,
      // ── Declaração de Conteúdo obrigatória (PPN-347). ──
      itensDeclaracaoConteudo: (input.itensDeclaracao && input.itensDeclaracao.length)
        ? input.itensDeclaracao.map((it) => ({
            conteudo: String(it.conteudo || 'Vestuário').slice(0, 60),
            quantidade: String(it.quantidade ?? 1),
            valor: (it.valor ?? (input.valorDeclarado ? input.valorDeclarado / input.itensDeclaracao!.length : 50)).toFixed(2),
          }))
        : [{ conteudo: 'Vestuário', quantidade: '1', valor: (input.valorDeclarado ?? 50).toFixed(2) }],
      observacao: '',
      // NF-e do envio: chave de 44 dígitos vai em chaveNFe (obrigatória na
      // pré-postagem desde 04/2026); valor curto (só o nº) cai no campo antigo.
      ...(input.nfeChave
        ? (input.nfeChave.replace(/\D/g, '').length === 44
          ? { chaveNFe: input.nfeChave.replace(/\D/g, '') }
          : { numeroNotaFiscal: input.nfeChave.replace(/\D/g, '') })
        : {}),
      ...(input.valorDeclarado ? { servicosAdicionais: [{ codigoServicoAdicional: '019', valorDeclarado: input.valorDeclarado.toFixed(2) }] } : {}),
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

  /**
   * Baixa a ETIQUETA (rótulo PDF) de uma pré-postagem. No CWS é assíncrono:
   * 1) solicita a geração → recebe idRecibo; 2) baixa por polling até ficar
   * pronto. Retorna o PDF em base64. Estrutura conforme a doc CWS; devolve a
   * resposta crua pra ajustar campos se a API divergir.
   */
  async baixarEtiqueta(idPrepostagem: string): Promise<any> {
    const id = String(idPrepostagem || '').trim();
    if (!id) throw new BadRequestException('idPrepostagem obrigatório');
    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;

    // 1) Solicita a geração assíncrona do rótulo
    let idRecibo: string | null = null;
    const sol = await axios.post(
      `${base}/prepostagem/v1/prepostagens/rotulo/assincrono/pdf`,
      // formatoRotulo 'PADRAO' traz a etiqueta + a DACE (declaração de conteúdo)
      // na mesma página; 'ETIQUETA' vem só o rótulo compacto (sem declaração).
      // Configurável por env pra iterar o valor sem deploy se a conta usar outro.
      {
        idsPrePostagem: [id],
        tipoRotulo: 'P',
        formatoRotulo: String(process.env.CORREIOS_FORMATO_ROTULO || 'PADRAO').trim(),
        imprimeRemetente: 'S',
        layoutImpressao: 'PADRAO',
        // Pede a DECLARAÇÃO DE CONTEÚDO (DACE) junto do rótulo. Nomes variam por
        // versão da API CWS — manda as variantes conhecidas (a API ignora as que
        // não usa).
        imprimeDeclaracaoConteudo: 'S',
        imprimeDC: 'S',
        declaracaoConteudo: 'S',
      },
      { headers, timeout: 30000, validateStatus: () => true },
    );
    if (sol.status < 200 || sol.status >= 300) {
      return { ok: false, etapa: 'solicitar', erro: sol.data?.msgs?.join('; ') || `HTTP ${sol.status}`, raw: sol.data };
    }
    idRecibo = sol.data?.idRecibo ?? sol.data?.id ?? null;
    if (!idRecibo) return { ok: false, etapa: 'solicitar', erro: 'API não devolveu idRecibo', raw: sol.data };

    // 2) Baixa por polling (o PDF leva alguns segundos pra ficar pronto)
    for (let i = 0; i < 12; i++) {
      const dl = await axios.get(
        `${base}/prepostagem/v1/prepostagens/rotulo/download/assincrono/${idRecibo}?tipoArquivo=ETIQUETA`,
        { headers, timeout: 30000, validateStatus: () => true },
      );
      if (dl.status >= 200 && dl.status < 300) {
        const pdf = dl.data?.dados ?? dl.data?.arquivo ?? dl.data?.pdf ?? null;
        if (pdf) return { ok: true, idRecibo, pdfBase64: String(pdf) };
        // sem PDF ainda (processando) → espera
      } else if (dl.status !== 404 && dl.status !== 425 && dl.status !== 202) {
        return { ok: false, etapa: 'download', erro: dl.data?.msgs?.join('; ') || `HTTP ${dl.status}`, raw: dl.data };
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    return { ok: false, etapa: 'download', erro: 'rótulo não ficou pronto a tempo (tente de novo em alguns segundos)', idRecibo };
  }

  /**
   * DEBUG: puxa a PRÉ-POSTAGEM CRUA da Correios (todos os campos) pra inspecionar
   * se a DC-e foi emitida (procurar chave/protocolo/DACE/QR no retorno). Não muta
   * nada. GET .../prepostagens/{id}.
   */
  async prepostagemRaw(idPrepostagem: string): Promise<any> {
    const id = String(idPrepostagem || '').trim();
    if (!id) throw new BadRequestException('idPrepostagem obrigatório');
    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;
    const dl = await axios.get(
      `${base}/prepostagem/v1/prepostagens/${encodeURIComponent(id)}`,
      { headers, timeout: 30000, validateStatus: () => true },
    );
    return { status: dl.status, data: dl.data };
  }

  /**
   * CANCELA uma pré-postagem nos Correios.
   *
   * Existe porque a trava de "não reabrir caixa com etiqueta" virou beco sem
   * saída: a caixa não podia ser reaberta e o sistema não tinha como desfazer a
   * etiqueta. Uma trava sem porta de saída é um defeito, não uma proteção.
   *
   * BEST-EFFORT DE PROPÓSITO: devolve `{ ok:false }` em vez de estourar. Se os
   * Correios recusarem (objeto já postado, id desconhecido, API fora), quem
   * chamou decide — e no nosso caso a pré-postagem abandonada simplesmente
   * caduca sem ser postada. O que NÃO pode é a caixa ficar presa.
   *
   * ⚠️ Escrito sem poder testar contra a API real (não tenho as credenciais de
   * produção aqui). O caminho DELETE .../prepostagens/{id} é o documentado no
   * CWS; se a conta responder outra coisa, o erro vem cru no `raw` em vez de
   * virar exceção.
   */
  async cancelarPrepostagem(idPrepostagem: string): Promise<any> {
    const id = String(idPrepostagem || '').trim();
    if (!id) return { ok: false, erro: 'idPrepostagem vazio' };
    try {
      const headers = await this.auth.authHeader();
      const base = this.auth.baseUrl;
      const r = await axios.delete(
        `${base}/prepostagem/v1/prepostagens/${encodeURIComponent(id)}`,
        { headers, timeout: 30000, validateStatus: () => true },
      );
      if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
      const d: any = r.data;
      const erro =
        (d && typeof d === 'object' ? d.msgs?.join('; ') || d.detail || d.message : null) ||
        `HTTP ${r.status}`;
      return { ok: false, status: r.status, erro, raw: d };
    } catch (e: any) {
      return { ok: false, erro: e?.message || String(e) };
    }
  }

  /**
   * Baixa a DECLARAÇÃO DE CONTEÚDO (DACE) de uma pré-postagem — documento
   * separado da etiqueta, que lista os itens (obrigatório em envio pra CPF sem
   * NF-e). É a mesma página que o QR code do rótulo abre.
   *
   * No CWS este endpoint é SÍNCRONO e devolve HTML (não é o fluxo assíncrono do
   * rótulo — path confirmado na doc: GET .../declaracaoconteudo/{id}). Devolve o
   * HTML pronto pra imprimir; raw pra iterar se a API divergir.
   */
  async baixarDeclaracaoConteudo(idPrepostagem: string): Promise<any> {
    const id = String(idPrepostagem || '').trim();
    if (!id) throw new BadRequestException('idPrepostagem obrigatório');
    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;

    const dl = await axios.get(
      `${base}/prepostagem/v1/prepostagens/declaracaoconteudo/${encodeURIComponent(id)}`,
      // Aceita HTML; axios só faz JSON.parse quando o corpo é JSON (erro), então
      // no sucesso dl.data vem como string (o HTML) e no erro como objeto.
      { headers: { ...headers, Accept: 'text/html' }, timeout: 30000, validateStatus: () => true },
    );
    if (dl.status < 200 || dl.status >= 300) {
      const d: any = dl.data;
      const erro = (d && typeof d === 'object' ? (d.msgs?.join('; ') || d.detail || d.message) : null) || `HTTP ${dl.status}`;
      return { ok: false, etapa: 'download', erro, raw: d };
    }
    const html = typeof dl.data === 'string' ? dl.data : (dl.data?.dados ?? dl.data?.html ?? null);
    if (!html || !String(html).trim()) {
      return { ok: false, etapa: 'download', erro: 'API não devolveu o HTML da declaração', raw: dl.data };
    }
    return { ok: true, html: String(html) };
  }

  /**
   * Rastreia um objeto pelo código (SRO/CWS). Devolve os eventos.
   *
   * ⚠️ `Accept-Language: pt-BR` É OBRIGATÓRIO (achado em 18/08). Sem o header o
   * SRO devolve **HTTP 400 SRO-018** ("permitido apenas pt-BR, en e es-ES para
   * o idioma") em TODA consulta — e o idioma não vai na query, só no header.
   * Como os crons que dependem disto tratam falha como "sem novidade"
   * (`if (!t?.ok) continue`), a quebra era invisível: nenhum pedido virou
   * `delivered` em 90 dias e o aviso "seu pedido chegou" saiu 3 vezes em
   * 22.678 pedidos.
   *
   * Objeto de OUTRO contrato responde 200 com `mensagem: "SRO-009: Objeto não
   * pertence ao contrato"` e zero eventos — é o caso das etiquetas emitidas
   * pelo Mais Envios, que o `TrackingService` cobre no fallback.
   */
  async rastrear(codigo: string): Promise<any> {
    const c = String(codigo || '').trim().toUpperCase();
    if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(c)) throw new BadRequestException('Código de rastreio inválido (ex.: AD722716975BR).');
    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;
    const r = await axios.get(`${base}/srorastro/v1/objetos/${c}?resultado=T`, {
      headers: { ...headers, 'Accept-Language': 'pt-BR' },
      timeout: 20000,
      validateStatus: () => true,
    });
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, erro: r.data?.msgs?.join('; ') || `HTTP ${r.status}`, raw: r.data };
    }
    const obj = r.data?.objetos?.[0] ?? null;
    return { ok: true, codigo: c, eventos: obj?.eventos ?? [], objeto: obj, raw: r.data };
  }

  /**
   * Rastreio em LOTE — o SRO aceita vários códigos numa chamada só
   * (`?codigosObjetos=A,B,C`), e é assim que o cron acompanha centenas de
   * objetos sem virar centenas de requests.
   *
   * Códigos fora do padrão são descartados antes de sair daqui: o campo de
   * rastreio é texto livre na mão da loja (já apareceu "Cliente retirou !") e
   * um item inválido derruba a chamada inteira.
   */
  async rastrearLote(codigos: string[]): Promise<Map<string, any>> {
    const validos = [
      ...new Set(
        (codigos || [])
          .map((c) => String(c || '').trim().toUpperCase())
          .filter((c) => /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(c)),
      ),
    ];
    const out = new Map<string, any>();
    if (!validos.length) return out;
    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;
    // 50 por chamada — o teto do SRO.
    for (let i = 0; i < validos.length; i += 50) {
      const fatia = validos.slice(i, i + 50);
      const r = await axios.get(`${base}/srorastro/v1/objetos`, {
        params: { codigosObjetos: fatia.join(','), resultado: 'T' },
        headers: { ...headers, 'Accept-Language': 'pt-BR' },
        timeout: 30000,
        validateStatus: () => true,
      });
      if (r.status < 200 || r.status >= 300) {
        this.logger.warn(
          `[correios] rastreio em lote falhou (HTTP ${r.status}): ${r.data?.msgs?.join('; ') || ''}`,
        );
        continue;
      }
      for (const obj of r.data?.objetos ?? []) {
        if (obj?.codObjeto) out.set(String(obj.codObjeto).toUpperCase(), obj);
      }
    }
    return out;
  }
}

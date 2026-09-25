import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PDFDocument as PdfLib } from 'pdf-lib';
import { EstornoComprovanteService } from './estorno-comprovante.service';
import { EstornosController } from './estornos.controller';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnlyGuard } from '../auth/admin-only.guard';

/**
 * O COMPROVANTE DE ESTORNO — o que não pode voltar a acontecer (25/09/2026).
 *
 * O "Baixar PDF" respondia `{"statusCode":500,"message":"Internal server
 * error"}` porque o `import * as PDFDocument from 'pdfkit'` com
 * `esModuleInterop` gera um namespace que não é construível. Estes testes
 * geram o PDF DE VERDADE (pdfkit real, sem mock) e conferem que ele é um
 * arquivo PDF válido, que o conteúdo tem tudo que a cliente precisa, que o
 * papel segue o gateway, e que falhar não toca no estorno nem no dinheiro.
 */

const AGORA = new Date('2026-09-25T18:11:26.000Z');
const ATOR = { userId: 'u1', nome: 'Thiago', ip: '127.0.0.1', dispositivo: 'jest' };

function estornoFake(over: Record<string, any> = {}) {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    origem: 'site',
    refId: 'order-1',
    refNumero: 'LP-001196',
    pdvSaleId: null,
    clienteNome: 'Maria da Silva',
    clienteCpf: '12345678909',
    clienteEmail: 'maria@gmail.com',
    gateway: 'pagbank',
    metodo: 'credit_card',
    gatewayOrderId: 'ORDE_1',
    gatewayChargeId: 'CHAR_ABC123',
    storeCode: 'SITE',
    valorPagoCents: 25990,
    jaEstornadoCents: 0,
    valorCents: 8990,
    tipo: 'parcial',
    motivo: 'devolucao_produto',
    motivoTexto: null,
    observacao: 'NOTA INTERNA que não pode sair no papel',
    status: 'processado',
    statusGateway: 'paid',
    mensagemGateway: null,
    estornadoTotalCents: 8990,
    idempotencyKey: 'op-1',
    createdAt: new Date('2026-09-25T17:40:00.000Z'),
    updatedAt: AGORA,
    processadoEm: AGORA,
    consultadoEm: AGORA,
    ...over,
  };
}

function montar(over: { estorno?: any; consultar?: jest.Mock } = {}) {
  const estorno = over.estorno ?? estornoFake();
  const update = jest.fn(async ({ data }: any) => ({ ...estorno, ...data }));
  const prisma: any = {
    estornoPagamento: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === estorno.id ? estorno : null)),
      update,
    },
    nfceConfig: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.storeCode === 'SITE'
          ? {
              storeCode: 'SITE',
              razaoSocial: 'LURDS PLUS SIZE LTDA',
              cnpj: '12345678000199',
              endereco: JSON.stringify({ logradouro: 'Rua X', numero: '10', bairro: 'Centro', municipio: 'Santos', uf: 'SP', cep: '11010-000' }),
            }
          : null,
      ),
    },
  };
  const email = { send: jest.fn(async () => true) };
  const acesso = { registrar: jest.fn(async () => undefined), exigirSessao: jest.fn() };
  const consultar = over.consultar ?? jest.fn(async () => estorno);
  const svc = new EstornoComprovanteService(prisma, email as any, acesso as any, { consultar } as any);
  return { svc, prisma, email, acesso, consultar, estorno, update };
}

describe('comprovante de estorno — o PDF sai, e sai certo', () => {
  it('estorno PROCESSADO vira um arquivo PDF válido, sem perguntar de novo ao gateway', async () => {
    const { svc, consultar, update } = montar();
    const r = await svc.gerar(estornoFake().id, ATOR);

    expect(r.filename).toBe('estorno-LP-001196.pdf');
    expect(r.titulo).toBe('ESTORNO PROCESSADO');
    expect(r.estorno.status).toBe('processado');
    expect(r.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(r.buffer.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);

    // Um leitor de PDF de verdade abre o arquivo e acha a página.
    const pdf = await PdfLib.load(r.buffer);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('Comprovante de estorno LP-001196');

    // `processado` é terminal e já veio do gateway: nada de reconsulta, nada de escrita.
    expect(consultar).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('o conteúdo traz pedido, cliente (mascarada), valor, tipo, datas, transação e o status do gateway — e NÃO a nota interna', () => {
    const { svc, estorno } = montar();
    const l = svc.linhasDoComprovante(estorno);

    expect(l.pedido).toEqual(
      expect.arrayContaining([
        ['Pedido', 'LP-001196'],
        ['Origem', 'Pedido do site'],
        ['Cliente', 'Maria da Silva'],
        ['CPF', '***.456.789-**'],
        ['E-mail', 'ma***@gmail.com'],
      ]),
    );
    expect(l.valores).toEqual(
      expect.arrayContaining([
        ['Valor pago', 'R$ 259,90'],
        ['Já estornado antes desta operação', 'R$ 0,00'],
        ['Valor DESTE estorno', 'R$ 89,90 (parcial)'],
        ['Saldo que continua pago', 'R$ 170,00'],
      ]),
    );
    expect(l.transacao).toEqual(
      expect.arrayContaining([
        ['Forma de pagamento', 'Cartão de crédito'],
        ['Gateway', 'PagBank'],
        ['Código da transação', 'CHAR_ABC123'],
        ['Pedido no gateway', 'ORDE_1'],
        ['Situação informada pelo gateway', 'paid'],
      ]),
    );
    // Hora de Brasília (17:40Z = 14:40 BRT), nunca a UTC do servidor.
    const solicitado = l.transacao.find(([k]) => k === 'Estorno solicitado em')?.[1] || '';
    expect(solicitado).toMatch(/25\/09\/2026,? 14:40/);
    const confirmado = l.transacao.find(([k]) => k === 'Confirmado pelo gateway em')?.[1] || '';
    expect(confirmado).toMatch(/25\/09\/2026,? 15:11/);

    expect(JSON.stringify(l)).not.toContain('NOTA INTERNA');
    expect(JSON.stringify(l)).not.toContain('12345678909');
  });

  it('estorno EM ABERTO pergunta ao gateway antes de imprimir, e o papel segue a resposta', async () => {
    const pendente = estornoFake({ status: 'processando', statusGateway: 'sem resposta', processadoEm: null });
    const confirmado = { ...pendente, status: 'processado', statusGateway: 'paid', processadoEm: AGORA };
    const consultar = jest.fn(async () => confirmado);
    const { svc } = montar({ estorno: pendente, consultar });

    const r = await svc.gerar(pendente.id, ATOR);

    expect(consultar).toHaveBeenCalledWith(pendente.id, ATOR);
    expect(r.titulo).toBe('ESTORNO PROCESSADO');
    expect(r.estorno.status).toBe('processado');
    expect(r.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('gateway fora do ar: o papel sai EM PROCESSAMENTO — nunca "processado" sem o gateway dizer', async () => {
    const pendente = estornoFake({ status: 'processando', statusGateway: 'sem resposta', processadoEm: null });
    const consultar = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const { svc, update } = montar({ estorno: pendente, consultar });

    const r = await svc.gerar(pendente.id, ATOR);

    expect(r.titulo).toBe('ESTORNO EM PROCESSAMENTO');
    expect(r.estorno.status).toBe('processando');
    expect(update).not.toHaveBeenCalled();
    const l = svc.linhasDoComprovante(r.estorno);
    expect(l.transacao).toEqual(expect.arrayContaining([['Confirmado pelo gateway em', 'aguardando confirmação']]));
  });

  it('estorno recusado ou com erro não vira comprovante nenhum', async () => {
    for (const status of ['recusado', 'erro']) {
      const e = estornoFake({ status });
      const { svc, consultar } = montar({ estorno: e });
      await expect(svc.gerar(e.id, ATOR)).rejects.toBeInstanceOf(BadRequestException);
      expect(consultar).not.toHaveBeenCalled();
    }
  });

  it('id que não existe é 404, não 500', async () => {
    const { svc } = montar();
    await expect(svc.gerar('nao-existe', ATOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('falha no desenho vira erro amigável, com o estorno intocado — clicar de novo é seguro', async () => {
    const { svc, update, acesso } = montar();
    jest.spyOn(svc as any, 'montar').mockRejectedValueOnce(new TypeError('PDFDocument is not a constructor'));

    const erro = await svc.gerar(estornoFake().id, ATOR).catch((e) => e);

    expect(erro).toBeInstanceOf(InternalServerErrorException);
    expect(String(erro.message)).toContain('O estorno não foi alterado');
    expect(String(erro.message)).not.toContain('not a constructor');
    expect(update).not.toHaveBeenCalled();
    expect(acesso.registrar).not.toHaveBeenCalled();

    // A tentativa seguinte (sem o defeito) sai normal.
    const r = await svc.gerar(estornoFake().id, ATOR);
    expect(r.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('o e-mail conta a mesma história do PDF anexado (usa o estorno DEPOIS da reconsulta)', async () => {
    const pendente = estornoFake({ status: 'processando', statusGateway: 'sem resposta', processadoEm: null });
    const confirmado = { ...pendente, status: 'processado', statusGateway: 'paid', processadoEm: AGORA };
    const consultar = jest.fn(async () => confirmado);
    const { svc, email, update } = montar({ estorno: pendente, consultar });

    const r = await svc.enviarPorEmail(pendente.id, undefined, ATOR);

    expect(r.ok).toBe(true);
    expect(r.para).toBe('maria@gmail.com');
    const [para, assunto, html, , anexos] = email.send.mock.calls[0] as any[];
    expect(para).toBe('maria@gmail.com');
    expect(assunto).toContain('ESTORNO PROCESSADO');
    expect(html).toContain('Confirmamos o estorno');
    expect(html).not.toContain('NOTA INTERNA');
    expect(anexos[0].filename).toBe('estorno-LP-001196.pdf');
    expect(anexos[0].contentType).toBe('application/pdf');
    expect(anexos[0].content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // O que foi gravado é só "enviado pra quem, quando" — status não muda aqui.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toEqual({ comprovanteEnviadoEm: expect.any(Date), comprovanteEmail: 'maria@gmail.com' });
  });
});

describe('comprovante de estorno — quem pode baixar', () => {
  function controller(over: { exigirSessao?: jest.Mock; gerar?: jest.Mock } = {}) {
    const acesso = { exigirSessao: over.exigirSessao ?? jest.fn(() => ({ userId: 'u1', nivel: 'MASTER' })) };
    const comprovantes = { gerar: over.gerar ?? jest.fn(async () => ({ buffer: Buffer.from('%PDF-1.3 fake'), filename: 'estorno-LP-1.pdf', titulo: 'ESTORNO PROCESSADO' })) };
    const ctrl = new EstornosController({} as any, comprovantes as any, acesso as any, {} as any);
    const res: any = { setHeader: jest.fn(), send: jest.fn() };
    const req: any = { user: { userId: 'u1', name: 'Thiago' }, headers: { 'user-agent': 'jest' }, ip: '127.0.0.1' };
    return { ctrl, acesso, comprovantes, res, req };
  }

  it('a classe inteira fica atrás do JWT e da role da matriz', () => {
    const guards: any[] = Reflect.getMetadata(GUARDS_METADATA, EstornosController) || [];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, AdminOnlyGuard]));
  });

  it('sem o bilhete da sessão (senha Master/Suprema da entrada) o PDF nem é gerado', async () => {
    const exigirSessao = jest.fn(() => {
      throw new ForbiddenException('Sessão de estornos expirada — digite a senha Master/Suprema de novo.');
    });
    const { ctrl, comprovantes, res, req } = controller({ exigirSessao });

    await expect(ctrl.comprovante('est1', 'bilhete-forjado', req, res)).rejects.toBeInstanceOf(ForbiddenException);
    expect(comprovantes.gerar).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('com o bilhete válido o PDF sai com os cabeçalhos certos e sem cache', async () => {
    const { ctrl, comprovantes, res, req, acesso } = controller();

    await ctrl.comprovante('est1', 'bilhete-ok', req, res);

    expect(acesso.exigirSessao).toHaveBeenCalledWith('bilhete-ok');
    expect(comprovantes.gerar).toHaveBeenCalledWith('est1', expect.objectContaining({ userId: 'u1', nome: 'Thiago', ip: '127.0.0.1' }));
    const headers = Object.fromEntries(res.setHeader.mock.calls);
    expect(headers['Content-Type']).toBe('application/pdf');
    expect(headers['Content-Disposition']).toContain('estorno-LP-1.pdf');
    expect(headers['Content-Length']).toBe(String(Buffer.from('%PDF-1.3 fake').length));
    expect(headers['Cache-Control']).toBe('no-store');
    expect(res.send).toHaveBeenCalledTimes(1);
  });
});

import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CrediarioPrintService } from './crediario-print.service';
import * as fs from 'fs';

const OVERRIDE_PATH = '/tmp/promissoria-coords.json';

/**
 * /pdv-diag — endpoints de DIAGNÓSTICO/CALIBRAÇÃO da promissória.
 * SEM JwtAuthGuard pra acesso direto pelo navegador durante calibração.
 *
 * SEGURO: só lida com geometria de impressão (coordenadas, paths, override
 * temporário em /tmp). Zero dado de cliente/venda.
 */
@Controller('pdv-diag')
export class PdvDiagController {
  constructor(private readonly crediarioPrint: CrediarioPrintService) {}

  /** GET /pdv-diag/coords — retorna coordenadas ATIVAS no servidor agora. */
  @Get('coords')
  async getCoords(@Res() res: Response) {
    try {
      const result = this.crediarioPrint.diagCoords();
      // Acrescenta info do override
      const hasOverride = fs.existsSync(OVERRIDE_PATH);
      res.status(200).json({ ...result, override_ativo: hasOverride, override_path: OVERRIDE_PATH });
    } catch (e: any) {
      res.status(500).json({ statusCode: 500, message: 'Erro no diag', detail: e?.message });
    }
  }

  /**
   * POST /pdv-diag/coords — salva o JSON em /tmp/ pra calibração ao vivo.
   * Body: o conteúdo COMPLETO do JSON de coords (mesmo schema do arquivo).
   * Próxima geração de PDF usa esse JSON. Some no redeploy.
   */
  @Post('coords')
  async postCoords(@Body() body: any, @Res() res: Response) {
    try {
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ message: 'Body inválido — envie JSON' });
      }
      fs.writeFileSync(OVERRIDE_PATH, JSON.stringify(body, null, 2), 'utf8');
      const result = this.crediarioPrint.diagCoords();
      res.status(200).json({ ok: true, salvo_em: OVERRIDE_PATH, coords_ativas: result });
    } catch (e: any) {
      res.status(500).json({ statusCode: 500, message: 'Erro ao salvar', detail: e?.message });
    }
  }

  /** DELETE /pdv-diag/coords — apaga o override, volta pro JSON deployado. */
  @Post('coords/reset')
  async resetCoords(@Res() res: Response) {
    try {
      if (fs.existsSync(OVERRIDE_PATH)) fs.unlinkSync(OVERRIDE_PATH);
      const result = this.crediarioPrint.diagCoords();
      res.status(200).json({ ok: true, coords_ativas: result });
    } catch (e: any) {
      res.status(500).json({ statusCode: 500, message: 'Erro ao resetar', detail: e?.message });
    }
  }

  /**
   * GET /pdv-diag/calibrar — página HTML com formulário de calibração ao vivo.
   * Cada campo tem inputs x/y/w em mm. Botão "Salvar+Gerar PDF" salva no servidor
   * e abre o PDF de teste em nova aba. Iteração: 5 segundos.
   */
  @Get('calibrar')
  async getCalibrar(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(CALIBRAR_HTML);
  }

  /**
   * GET /pdv-diag/cliente?cpf=XXX — busca cliente no Giga, retorna a linha
   * CRUA + lista de colunas. Pra entender por que endereço/CEP não estão vindo.
   * Sem auth pra acesso direto pelo navegador (debug).
   */
  @Get('cliente')
  async getCliente(@Query('cpf') cpf: string, @Res() res: Response) {
    try {
      const result = await this.crediarioPrint.diagCliente(cpf);
      res.status(200).json(result);
    } catch (e: any) {
      res.status(500).json({ statusCode: 500, message: 'Erro no diag-cliente', detail: e?.message });
    }
  }

  /**
   * GET /pdv-diag/sale?id=SALE_ID — diagnóstico COMPLETO de uma venda específica.
   * Mostra: dados do banco local + cliente cru do Giga + cliente montado pro PDF
   * + diagnóstico do POR QUE endereço/CEP estão vazios (se estiverem).
   * USE ESSE pra entender por que o PDF de uma venda real não puxa o endereço.
   */
  @Get('sale')
  async getSale(@Query('id') id: string, @Res() res: Response) {
    try {
      if (!id) return res.status(400).json({ message: 'Query param "id" obrigatório' });
      const result = await this.crediarioPrint.diagSale(id);
      res.status(200).json(result);
    } catch (e: any) {
      res.status(500).json({ statusCode: 500, message: 'Erro no diag-sale', detail: e?.message });
    }
  }
}

const CALIBRAR_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Calibração Promissória — Lurd's</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 20px; background: #f5f5f5; }
  h1 { font-size: 18px; margin: 0 0 10px; }
  .topo { background: #fff; padding: 12px 16px; border-radius: 6px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .card { background: #fff; padding: 12px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .card h3 { margin: 0 0 8px; font-size: 13px; color: #555; }
  .row { display: grid; grid-template-columns: 110px 70px 70px 70px; gap: 6px; align-items: center; margin-bottom: 4px; font-size: 13px; }
  .row label { font-weight: 500; color: #333; }
  .row input { width: 60px; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; text-align: right; font-family: monospace; }
  .row .suffix { color: #888; font-size: 11px; }
  .blocosY { display: flex; gap: 8px; align-items: center; }
  .blocosY input { width: 70px; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; text-align: right; font-family: monospace; }
  .actions { position: sticky; bottom: 0; background: #fff; padding: 12px 16px; margin-top: 12px; border-radius: 6px; box-shadow: 0 -2px 6px rgba(0,0,0,.1); display: flex; gap: 10px; align-items: center; }
  button { padding: 10px 18px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .btn-primary { background: #2563eb; color: white; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-secondary { background: #e5e7eb; color: #333; }
  .btn-secondary:hover { background: #d1d5db; }
  .btn-danger { background: #dc2626; color: white; }
  .status { margin-left: auto; font-size: 13px; color: #555; }
  .status.ok { color: #16a34a; font-weight: 600; }
  .status.err { color: #dc2626; font-weight: 600; }
  .help { font-size: 12px; color: #666; margin: 4px 0 12px; line-height: 1.4; }
  .override-warn { background: #fef3c7; border: 1px solid #f59e0b; padding: 8px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 8px; }
</style>
</head>
<body>

<div class="topo">
  <h1>Calibração da Promissória</h1>
  <div class="help">
    Edita os valores em <strong>mm</strong>, clica <strong>Salvar + Gerar PDF</strong>. PDF abre em nova aba — imprime em 100% e sobrepõe na pré-impressa.<br>
    Os ajustes ficam em <code>/tmp</code> do servidor (não vão pro Git). Quando estiver bom, clica <strong>Exportar JSON</strong> e cola em <code>backend/assets/config/promissoria-coords.json</code> + commit.
  </div>
  <div id="overrideWarn"></div>
</div>

<div class="topo">
  <h3 style="margin:0 0 6px">Topos dos blocos (mm do topo da folha A4)</h3>
  <div class="blocosY">
    <label>Bloco 1: <input type="number" step="0.1" id="bloco1" /></label>
    <label>Bloco 2: <input type="number" step="0.1" id="bloco2" /></label>
    <label>Bloco 3: <input type="number" step="0.1" id="bloco3" /></label>
  </div>
</div>

<div class="grid" id="campos"></div>

<div class="actions">
  <button class="btn-primary" id="btnSalvar" type="button">💾 Salvar + Gerar PDF</button>
  <a class="btn-secondary" id="lnkGerar" href="/api/pdv/promissorias-teste-pdf" target="_blank" style="text-decoration:none;display:inline-block;line-height:1.5">🖨️ Só Gerar PDF</a>
  <button class="btn-secondary" id="btnExportar" type="button">📋 Exportar JSON</button>
  <button class="btn-danger" id="btnResetar" type="button">↩️ Resetar</button>
  <a class="btn-secondary" href="/api/pdv-diag/coords" target="_blank" style="text-decoration:none;display:inline-block;line-height:1.5">🔍 Ver coords ativas</a>
  <span class="status" id="status">Carregando…</span>
</div>

<script>
const CAMPOS = [
  { key: 'numero',         label: 'Número (2315)' },
  { key: 'parcela',        label: 'Parcela (1/4)' },
  { key: 'valor',          label: 'Valor (R$)' },
  { key: 'vencDia',        label: 'Venc. Dia' },
  { key: 'vencMes',        label: 'Venc. Mês' },
  { key: 'vencAno',        label: 'Venc. Ano' },
  { key: 'vencExtenso',    label: 'Venc. Extenso', hasW: true },
  { key: 'beneficiarioA',  label: 'Razão Social' },
  { key: 'cpfDevedor',     label: 'CNPJ' },
  { key: 'quantiaExtenso', label: 'Valor Extenso', hasW: true },
  { key: 'pagavelEm',      label: 'Pagável em (Cidade)' },
  { key: 'emissaoDia',     label: 'Emissão Dia' },
  { key: 'emissaoMes',     label: 'Emissão Mês' },
  { key: 'emissaoAno',     label: 'Emissão Ano' },
  { key: 'emitente',       label: 'Emitente (Nome)' },
  { key: 'cpfEmitente',    label: 'CPF Emitente' },
  { key: 'endereco',       label: 'Endereço', hasW: true },
  { key: 'cep',            label: 'CEP' },
];

const grid = document.getElementById('campos');
for (var i = 0; i < CAMPOS.length; i++) {
  var c = CAMPOS[i];
  var card = document.createElement('div');
  card.className = 'card';
  var wInput = c.hasW
    ? '<input type="number" step="0.1" id="' + c.key + '_w" placeholder="w" />'
    : '<span></span>';
  var wLabel = c.hasW ? '<span class="suffix">w mm</span>' : '<span></span>';
  card.innerHTML =
    '<div class="row">' +
      '<label>' + c.label + '</label>' +
      '<input type="number" step="0.1" id="' + c.key + '_x" placeholder="x" />' +
      '<input type="number" step="0.1" id="' + c.key + '_y" placeholder="y" />' +
      wInput +
    '</div>' +
    '<div class="row">' +
      '<span class="suffix"></span>' +
      '<span class="suffix">x mm</span>' +
      '<span class="suffix">y mm</span>' +
      wLabel +
    '</div>';
  grid.appendChild(card);
}

function setStatus(txt, cls = '') {
  const el = document.getElementById('status');
  el.textContent = txt;
  el.className = 'status ' + cls;
}

async function carregar() {
  setStatus('Carregando…');
  try {
    const r = await fetch('/api/pdv-diag/coords');
    const j = await r.json();
    if (j.blocoY_mm) {
      document.getElementById('bloco1').value = j.blocoY_mm[0];
      document.getElementById('bloco2').value = j.blocoY_mm[1];
      document.getElementById('bloco3').value = j.blocoY_mm[2];
    }
    if (j.campos_ativos_mm) {
      for (const [k, v] of Object.entries(j.campos_ativos_mm)) {
        const x = document.getElementById(k + '_x');
        const y = document.getElementById(k + '_y');
        const w = document.getElementById(k + '_w');
        if (x) x.value = v.x;
        if (y) y.value = v.y;
        if (w && v.w !== undefined) w.value = v.w;
      }
    }
    document.getElementById('overrideWarn').innerHTML = j.override_ativo
      ? '<div class="override-warn">⚠️ Usando override em /tmp — clique "Resetar" pra voltar pro JSON deployado.</div>'
      : '';
    setStatus('Pronto', 'ok');
  } catch (e) {
    setStatus('Erro ao carregar: ' + e.message, 'err');
  }
}

function montarJson() {
  const out = {
    blocosY_mm: [
      parseFloat(document.getElementById('bloco1').value),
      parseFloat(document.getElementById('bloco2').value),
      parseFloat(document.getElementById('bloco3').value),
    ],
    fields_mm: {},
  };
  for (const c of CAMPOS) {
    const x = parseFloat(document.getElementById(c.key + '_x').value);
    const y = parseFloat(document.getElementById(c.key + '_y').value);
    const obj = { x, y };
    if (c.hasW) {
      const w = parseFloat(document.getElementById(c.key + '_w').value);
      if (!isNaN(w)) obj.w = w;
    }
    if (!isNaN(x) && !isNaN(y)) out.fields_mm[c.key] = obj;
  }
  return out;
}

async function salvarEAbrir() {
  setStatus('Salvando…');
  try {
    const json = montarJson();
    const r = await fetch('/api/pdv-diag/coords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    setStatus('Salvo! Abrindo PDF…', 'ok');
    window.open('/api/pdv/promissorias-teste-pdf?_t=' + Date.now(), '_blank');
    await carregar();
  } catch (e) {
    setStatus('Erro: ' + e.message, 'err');
  }
}

function apenasGerar() {
  window.open('/api/pdv/promissorias-teste-pdf?_t=' + Date.now(), '_blank');
}

function exportarJson() {
  const json = montarJson();
  const txt = JSON.stringify(json, null, 2);
  navigator.clipboard.writeText(txt).then(() => {
    setStatus('JSON copiado pra área de transferência!', 'ok');
  });
}

async function resetar() {
  if (!confirm('Apagar override? Vai voltar pro JSON deployado.')) return;
  setStatus('Resetando…');
  try {
    await fetch('/api/pdv-diag/coords/reset', { method: 'POST' });
    setStatus('Resetado', 'ok');
    await carregar();
  } catch (e) {
    setStatus('Erro: ' + e.message, 'err');
  }
}

// Liga handlers via addEventListener (mais robusto que onclick inline)
function ligarBotoes() {
  var b1 = document.getElementById('btnSalvar');
  if (b1) b1.addEventListener('click', salvarEAbrir);
  var b2 = document.getElementById('btnExportar');
  if (b2) b2.addEventListener('click', exportarJson);
  var b3 = document.getElementById('btnResetar');
  if (b3) b3.addEventListener('click', resetar);
}

ligarBotoes();
carregar();
</script>
</body>
</html>`;

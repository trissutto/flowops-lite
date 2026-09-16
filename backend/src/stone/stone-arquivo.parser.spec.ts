import { lerArquivoStone } from './stone-arquivo.parser';

/**
 * Arquivo de conciliação da Stone no formato da documentação (layout 2.4,
 * mesmo nó Transaction do 2.2). Os valores são inventados; a estrutura é a
 * dos exemplos oficiais.
 */
const XML = `<?xml version="1.0" encoding="utf-8"?>
<Conciliation xmlns:xsd="http://schemas.stone.com/">
  <Header>
    <GenerationDateTime>20260916051233</GenerationDateTime>
    <StoneCode>123456789</StoneCode>
    <LayoutVersion>2.4</LayoutVersion>
    <FileId>1</FileId>
    <ReferenceDate>20260915</ReferenceDate>
  </Header>
  <FinancialTransactions>
    <Transaction>
      <Events>
        <CancellationCharges>0</CancellationCharges><Cancellations>0</Cancellations><Captures>1</Captures>
        <ChargebackRefunds>0</ChargebackRefunds><Chargebacks>0</Chargebacks><Payments>0</Payments>
      </Events>
      <AcquirerTransactionKey>26153245527825</AcquirerTransactionKey>
      <InitiatorTransactionKey>48ebaab8bc77444e</InitiatorTransactionKey>
      <AuthorizationDateTime>20260915173244</AuthorizationDateTime>
      <CaptureLocalDateTime>20260915143244</CaptureLocalDateTime>
      <International>False</International>
      <AccountType>2</AccountType>
      <InstallmentType>2</InstallmentType>
      <NumberOfInstallments>3</NumberOfInstallments>
      <AuthorizedAmount>299.700000</AuthorizedAmount>
      <CapturedAmount>299.700000</CapturedAmount>
      <AuthorizationCurrencyCode>986</AuthorizationCurrencyCode>
      <IssuerAuthorizationCode>164461</IssuerAuthorizationCode>
      <BrandId>2</BrandId>
      <CardNumber>536487******3492</CardNumber>
      <Poi><PoiType>1</PoiType><SerialNumber>6B123456</SerialNumber></Poi>
      <EntryMode>1</EntryMode>
      <FeeType>1</FeeType>
      <Installments>
        <Installment><InstallmentNumber>1</InstallmentNumber><GrossAmount>99.900000</GrossAmount><NetAmount>96.900000</NetAmount><PrevisionPaymentDate>20261015</PrevisionPaymentDate><MdrAmount>3.000000</MdrAmount></Installment>
        <Installment><InstallmentNumber>2</InstallmentNumber><GrossAmount>99.900000</GrossAmount><NetAmount>96.900000</NetAmount><PrevisionPaymentDate>20261114</PrevisionPaymentDate><MdrAmount>3.000000</MdrAmount></Installment>
        <Installment><InstallmentNumber>3</InstallmentNumber><GrossAmount>99.900000</GrossAmount><NetAmount>96.900000</NetAmount><PrevisionPaymentDate>20261214</PrevisionPaymentDate><MdrAmount>3.000000</MdrAmount></Installment>
      </Installments>
    </Transaction>
    <Transaction>
      <Events>
        <CancellationCharges>0</CancellationCharges><Cancellations>0</Cancellations><Captures>1</Captures>
        <ChargebackRefunds>0</ChargebackRefunds><Chargebacks>0</Chargebacks><Payments>0</Payments>
      </Events>
      <AcquirerTransactionKey>27153512306788</AcquirerTransactionKey>
      <InitiatorTransactionKey>8db91380ac7c4148</InitiatorTransactionKey>
      <AuthorizationDateTime>20260915122144</AuthorizationDateTime>
      <CaptureLocalDateTime>20260915092144</CaptureLocalDateTime>
      <AccountType>1</AccountType>
      <InstallmentType>1</InstallmentType>
      <NumberOfInstallments>1</NumberOfInstallments>
      <AuthorizedAmount>89.900000</AuthorizedAmount>
      <CapturedAmount>89.900000</CapturedAmount>
      <IssuerAuthorizationCode>604171</IssuerAuthorizationCode>
      <BrandId>171</BrandId>
      <CardNumber>650487******0011</CardNumber>
      <Poi><PoiType>1</PoiType></Poi>
      <Installments>
        <Installment><InstallmentNumber>1</InstallmentNumber><GrossAmount>89.900000</GrossAmount><NetAmount>88.550000</NetAmount><PrevisionPaymentDate>20260916</PrevisionPaymentDate></Installment>
      </Installments>
    </Transaction>
    <Transaction>
      <Events>
        <CancellationCharges>0</CancellationCharges><Cancellations>1</Cancellations><Captures>1</Captures>
        <ChargebackRefunds>0</ChargebackRefunds><Chargebacks>0</Chargebacks><Payments>0</Payments>
      </Events>
      <AcquirerTransactionKey>27853677426052</AcquirerTransactionKey>
      <InitiatorTransactionKey>f6e687d547634600</InitiatorTransactionKey>
      <AuthorizationDateTime>20260915201716</AuthorizationDateTime>
      <CaptureLocalDateTime>20260915171716</CaptureLocalDateTime>
      <AccountType>2</AccountType>
      <InstallmentType>1</InstallmentType>
      <NumberOfInstallments>1</NumberOfInstallments>
      <AuthorizedAmount>39.850000</AuthorizedAmount>
      <CapturedAmount>39.850000</CapturedAmount>
      <CanceledAmount>39.850000</CanceledAmount>
      <IssuerAuthorizationCode>T04779</IssuerAuthorizationCode>
      <BrandId>1</BrandId>
      <CardNumber>415896******9426</CardNumber>
      <EntryMode>1</EntryMode>
      <Cancellations>
        <Cancellation>
          <OperationKey>jrepqyf48p6ufk7bsbr2cdv3y</OperationKey>
          <CancellationDateTime>20260915171906</CancellationDateTime>
          <ReturnedAmount>39.850000</ReturnedAmount>
        </Cancellation>
      </Cancellations>
    </Transaction>
    <Transaction>
      <Events>
        <CancellationCharges>0</CancellationCharges><Cancellations>1</Cancellations><Captures>0</Captures>
        <ChargebackRefunds>0</ChargebackRefunds><Chargebacks>0</Chargebacks><Payments>0</Payments>
      </Events>
      <AcquirerTransactionKey>11442285088218</AcquirerTransactionKey>
      <Cancellations>
        <Cancellation>
          <PaymentId>2552037926</PaymentId>
          <OperationKey>abc123</OperationKey>
          <InstallmentNumber>1</InstallmentNumber>
          <CancellationDateTime>20260915100000</CancellationDateTime>
          <ReturnedAmount>150.000000</ReturnedAmount>
        </Cancellation>
      </Cancellations>
    </Transaction>
  </FinancialTransactions>
  <FinancialEvents />
  <Trailer><CapturedTransactionsQuantity>3</CapturedTransactionsQuantity></Trailer>
</Conciliation>`;

describe('arquivo de conciliação da Stone', () => {
  const a = lerArquivoStone(XML);

  it('lê o cabeçalho', () => {
    expect(a).toMatchObject({ stoneCode: '123456789', dataReferencia: '2026-09-15', layout: '2.4' });
    expect(a.capturas).toHaveLength(3);
  });

  it('crédito parcelado: valor, parcelas, bandeira, cartão, taxa e 1º repasse', () => {
    const c = a.capturas[0];
    expect(c).toMatchObject({
      chave: '26153245527825',
      tipo: 'credito',
      parcelas: 3,
      valorCapturado: 299.7,
      valorCancelado: 0,
      bandeira: 'MASTERCARD',
      finalCartao: '3492',
      autorizacao: '164461',
      terminal: 'POS',
      serial: '6B123456',
      diaLocal: '2026-09-15',
      horaLocal: '14:32',
      valorLiquido: 290.7,
      taxa: 9,
      previsaoPagamento: '2026-10-15',
    });
    // 14:32:44 em Brasília = 17:32:44 UTC
    expect(c.capturadaEm.toISOString()).toBe('2026-09-15T17:32:44.000Z');
  });

  it('débito Elo sem MdrAmount calcula a taxa pelo bruto − líquido', () => {
    const c = a.capturas[1];
    expect(c).toMatchObject({ tipo: 'debito', bandeira: 'ELO', valorCapturado: 89.9, taxa: 1.35, finalCartao: '0011' });
  });

  it('cancelada no mesmo dia vem com o valor cancelado', () => {
    const c = a.capturas[2];
    expect(c.valorCapturado).toBe(39.85);
    expect(c.valorCancelado).toBe(39.85);
    expect(c.cancelamentos).toHaveLength(1);
    expect(c.cancelamentos[0].canceladaEm?.toISOString()).toBe('2026-09-15T20:19:06.000Z');
    expect(c.terminal).toBeNull();
  });

  it('cancelamento de venda de outro dia vem avulso, só com a chave', () => {
    expect(a.cancelamentosAvulsos).toEqual([
      { chave: '11442285088218', canceladaEm: new Date('2026-09-15T13:00:00.000Z'), valorDevolvido: 150 },
    ]);
  });

  it('arquivo vazio de venda não quebra', () => {
    const vazio = lerArquivoStone(
      '<Conciliation><Header><StoneCode>1</StoneCode><ReferenceDate>20260913</ReferenceDate></Header><FinancialTransactions /></Conciliation>',
    );
    expect(vazio.capturas).toEqual([]);
    expect(vazio.dataReferencia).toBe('2026-09-13');
  });

  it('o que não é XML da Stone é erro, nunca "dia sem venda"', () => {
    expect(() => lerArquivoStone('{"erro":"x"}')).toThrow('não é XML');
    expect(() => lerArquivoStone('<html><body>Forbidden</body></html>')).toThrow('<Conciliation>');
  });
});

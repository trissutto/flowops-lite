import { EmailService } from './email.service';

/**
 * O CASO REAL (25/08/2026): em produção a `SMTP_FROM` estava valendo
 * `Lurd's Plus Size` — só o nome, sem `<endereco@dominio>`. O nodemailer
 * aceita e monta `{ address: '', name: "Lurd's Plus Size" }`, o envelope sai
 * com `from: false` e o Gmail recusa. O `send()` devolvia o MESMO `false` de
 * "SMTP não configurado", então ninguém conseguia distinguir — e o e-mail do
 * código de postagem da troca simplesmente não existia.
 */
describe('EmailService.resolverFrom', () => {
  const USER = 'atendimento@lurdsplussize.com.br';

  it('nome sem endereço vira "Nome <SMTP_USER>" — o erro de env não derruba o canal', () => {
    expect(EmailService.resolverFrom("Lurd's Plus Size", USER)).toBe(
      `Lurd's Plus Size <${USER}>`,
    );
  });

  it('não mexe no que já está completo', () => {
    const ok = `Lurd's Plus Size <${USER}>`;
    expect(EmailService.resolverFrom(ok, USER)).toBe(ok);
    expect(EmailService.resolverFrom(USER, USER)).toBe(USER);
  });

  it('sem SMTP_FROM usa o próprio usuário autenticado', () => {
    expect(EmailService.resolverFrom(undefined, USER)).toBe(USER);
    expect(EmailService.resolverFrom('   ', USER)).toBe(USER);
  });

  it('sem usuário nenhum cai no padrão da casa', () => {
    expect(EmailService.resolverFrom(undefined, '')).toContain('@');
  });

  it('limpa < > perdidos no nome pra não gerar endereço torto', () => {
    expect(EmailService.resolverFrom('<Lurds>', USER)).toBe(`Lurds <${USER}>`);
  });
});

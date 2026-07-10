# Plano — Onboarding + RH + PIN + Ponto Facial da Funcionária

> Documento de projeto pra revisão do Thiago **antes** de escrever código.
> Nada aqui está implementado ainda. Data do desenho: 10/07/2026.

## 1. Objetivo em uma frase
Um **portal simples de cadastro da funcionária** (que ela mesma preenche pelo
celular), alimentando o RH, definindo **função + PIN pessoal** pra liberar
descontos com rastreabilidade, e capturando o **rosto pra bater ponto por
reconhecimento facial**. Cada loja só enxerga as **suas** funcionárias.

## 2. Decisões já tomadas (travadas)
| Tema | Decisão |
|---|---|
| Identificação no PDV | **Só o PIN** (6 dígitos), sem digitar nome |
| Escopo do PIN | **Por pessoa/CPF** (um PIN vale em qualquer loja) |
| Senha mestra | **Manter** MASTER/SUPREMA de hoje como socorro de emergência |
| Facial | **Bater ponto por reconhecimento** (biometria) |
| Auto-cadastro | Funcionária preenche **dados + selfie + próprio PIN**; **gerente aprova a função/nível** |
| Isolamento | Loja vê **só as suas**; matriz/RH vê todas |
| UI | **Lúdica e simples** — assistente no celular, 1 passo por tela, botão grande, pouca digitação |

## 3. O que muda no motor de senhas (base de tudo)
Hoje (`backend/src/auth/auth-levels.util.ts`): a senha devolve **o nível**
(CAIXA/GERENTE/…), mas **não sabe QUEM** digitou.

Depois: o PIN devolve **nível + pessoa**.
- Digitou o PIN → o sistema varre os operadores ativos, acha de quem é, lê o
  nível dela, confere se é suficiente **e carimba o nome** no registro.
- Se o PIN não bater, cai na **senha mestra** de hoje (MASTER/SUPREMA) — ninguém trava.
- Hierarquia atual continua idêntica: SUPREMA > MASTER > GERENTE > SUPERVISOR > CAIXA > VENDEDOR.

**Ganho central:** toda liberação passa a gravar *"autorizado por: Fulana"* no
histórico da venda / log de descontos. Hoje é anônimo.

### Travas de segurança do PIN (6 dígitos é curto — precisam existir)
1. **Anti-tentativa:** errou 5x → bloqueia por alguns minutos (evita chute dos 6 dígitos).
2. **Bloquear PIN óbvio:** barra `123456`, `000000`, sequência, repetição.
3. **CPF obrigatório** pra quem tem PIN (sem CPF não dá pra ser "quem autorizou").
   Quem só vende, sem liberar nada, não precisa de PIN.

## 4. Papéis e acesso (quem faz o quê)
- **Funcionária (ela mesma):** preenche/edita os próprios dados pessoais + selfie
  + cria o próprio PIN. **NÃO** escolhe a própria função/nível.
- **Gerente da loja:** vê e aprova as funcionárias **da sua loja**; define
  função/nível (poder de liberar desconto), reseta PIN, ativa/desliga.
- **RH / Matriz:** vê todas as lojas, relatórios, exporta dados.
- Regra de ouro: **auto-cadastro é ótimo pra DADO, proibido pra PODER** — a caixa
  nunca se auto-promove a gerente.

## 5. Dados de RH (cadastro simples — enxuto)
Marcados como (obrig.) / (opc.):
- **Identificação:** nome completo (obrig.), CPF (obrig.), RG (opc.), nascimento (obrig.), sexo (opc.)
- **Contato:** celular (obrig.), e-mail (opc.), endereço (opc.)
- **Trabalho:** loja (obrig., vem do convite), função/nível (**definida pela gerente**), admissão (opc.), CTPS/PIS (opc., pra folha)
- **Bancário (pra salário):** chave PIX ou banco/agência/conta (opc., **sensível** — guardar com cuidado)
- **Emergência:** contato de emergência (opc.)
- **Documentos:** foto de RG/CPF (já existe `SellerDocument` no schema)
- **Facial:** template do rosto + consentimento (ver LGPD)

## 6. ⚠️ LGPD — biometria é dado SENSÍVEL (ler antes de fazer)
Rosto/biometria é **dado pessoal sensível** (LGPD art. 5º II e art. 11). Com
funcionária, o cuidado é maior (relação de trabalho). Requisitos:
- **Consentimento explícito** registrado (quem, quando, versão do texto, IP).
- **Alternativa ao rosto** pra quem não consentir (ex.: ponto por PIN/manual) —
  em geral **não se pode obrigar** biometria no trabalho.
- **Finalidade limitada:** o rosto serve **só pro ponto** (não reaproveitar pra
  outra coisa sem novo consentimento).
- **Minimização:** guardar **template/vetor matemático**, não a foto crua, quando
  possível; criptografado; apagar quando a funcionária for desligada.
- **Texto de consentimento:** recomendo uma revisão rápida com contador/advogado.

## 7. As telas (lúdicas e simples)
**Onboarding da funcionária (celular):**
1. Boas-vindas + **aceite LGPD** (foto/biometria) — botão grande "Concordo".
2. Dados pessoais — **1 campo por tela**, teclado certo (numérico pro CPF etc.).
3. **Selfie guiada** (com liveness — ver Fase C).
4. **Cria o PIN** de 6 dígitos (aplicando as travas do item 3).
5. "Prontinho! 💜 Aguardando a gerente liberar sua função."

**Painel da gerente (loja):**
- Lista de **pendentes** da sua loja → aprova função/nível → ativa.
- Vê/edita as suas funcionárias, reseta PIN, desliga.

## 8. Modelo de dados (rascunho)
- **`Funcionaria`** (chave CPF): dados pessoais, loja(s), status
  (`convidada`/`pendente`/`ativa`/`desligada`), datas.
- **PIN** (na Funcionaria ou tabela `OperadorPin`): `nivel`, `pinHash`, `pinSalt`, `ativo`.
- **`FaceTemplate`:** `funcionariaId`, `embedding` (criptografado), `enrolledAt`, `provider/versão`.
- **`Consentimento`:** `funcionariaId`, tipo (biometria/ponto), texto/versão, aceito_em, IP.
- Liga no **`Seller`** existente (por loja, pra comissão) e no módulo **Ponto**.

## 9. Ponto Facial — a parte pesada (Fase C), honestamente
Reconhecimento facial pra ponto tem 4 desafios reais:
1. **Onde roda o ponto?** (PC da loja com câmera? celular da funcionária?) — definir.
2. **Motor de reconhecimento:** nuvem (AWS Rekognition/Azure) — preciso, mas manda
   biometria pra terceiro (custo + LGPD); **ou** auto-hospedado (fica na sua infra,
   melhor LGPD, mas você roda o ML). **Decisão pendente.**
3. **Liveness (anti-fraude):** sem detectar "vivacidade", dá pra bater ponto com a
   **foto da colega**. É a parte mais difícil e mais importante do ponto facial.
4. **Falha da cara:** sempre precisa de **plano B** (PIN/gerente) quando o rosto não
   reconhece (luz ruim, etc.), senão a pessoa não bate ponto.

**Alternativa mais leve pra considerar:** "ponto com **foto** " — tira a selfie no
momento do ponto e **guarda como comprovante** (sem reconhecimento em tempo real).
Inibe fraude (fica registrado quem apareceu), custa quase nada e é bem mais leve de
LGPD. Talvez entregue 80% do valor com 20% do trabalho — vale decidir se o
reconhecimento automático é mesmo necessário ou se a foto-comprovante já resolve.

## 10. Sequência de entrega (pra ter valor rápido)
- **Fase A — PIN + função + rastro (não mexe no PDV ao vivo).**
  Cadastro pela gerente com função+PIN; liberação de desconto passa a gravar quem
  autorizou. *Já dá o ganho principal.*
- **Fase B — Auto-cadastro pelo celular.**
  Assistente lúdico: dados de RH + selfie (só foto) + PIN + aceite LGPD + fluxo de
  aprovação da gerente. Loja vê só as suas.
- **Fase C — Ponto facial.**
  Enrollment do rosto, motor de reconhecimento, liveness, plano B, consentimento.
  (Ou a versão leve "ponto com foto-comprovante", se a gente decidir que basta.)

## 11. Decisões que ainda faltam (pra fechar a Fase C)
- [ ] Onde bate o ponto facial: PC da loja ou celular da funcionária?
- [ ] Reconhecimento **automático** ou **foto-comprovante** (mais leve)?
- [ ] Se automático: motor em **nuvem** ou **auto-hospedado**?
- [ ] Texto de consentimento LGPD — quem revisa (contador/advogado)?
- [ ] Custo aceitável por batida de ponto (se for nuvem)?

## 12. O que EU recomendo
Fechar e construir a **Fase A** já (valor imediato, risco baixo, não toca o PDV ao
vivo). Rodar a **Fase B** em seguida. Deixar a **Fase C** por último e, nela,
seriamente considerar começar pela **foto-comprovante** antes do reconhecimento
automático — mais barato, mais rápido, LGPD mais tranquila, e você vê na prática se
o reconhecimento automático é mesmo necessário.

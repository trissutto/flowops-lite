# Busca com IA — o slot já existe

A camada de intenção da busca é uma **interface**, não uma implementação:

```ts
// src/lib/search/types.ts
export interface IntentInterpreter {
  interpret(term: string): Intent;
}
```

Hoje quem implementa é `heuristicInterpreter` (`src/lib/search/intent.ts`):
dicionário de sinônimos + extração de frases + regex de preço. Quando a IA
entrar, ela implementa **esta mesma interface** — motor e UI não mudam uma
linha. Esse é o slot.

## O desenho do futuro `/api/search/intent`

```
UI ──► interpretador híbrido
        │
        ├─ 1. heurística local (síncrona, 0ms) → resposta imediata
        │     · confidence 'alta'  → PRONTO, nem chama a IA
        │     · confidence 'media'/'baixa' → usa a heurística JÁ e…
        │
        └─ 2. POST /api/search/intent { term }        (assíncrono)
              route handler (BFF) → LLM com prompt curto:
              · contexto: o VOCABULÁRIO de synonyms.ts + a lista de
                facetas válidas do catálogo (o LLM não inventa categoria)
              · saída: JSON no shape exato de `Intent` (facets + residual
                + label + confidence) — validada com zod antes de usar
              · resposta melhor que a heurística → re-ranqueia
```

Regras do desenho:

1. **A heurística é o fallback PERMANENTE, não um andaime.** Motivos:
   - Latência: autocomplete precisa responder por tecla; LLM não.
   - Custo: busca é o evento mais frequente do site — pagar token por
     tecla não fecha conta.
   - Disponibilidade: IA fora do ar não pode derrubar a busca (mesma
     filosofia do espelho Wincred no FlowOps: o caminho crítico nunca
     depende do serviço que pode pendurar).
   - Frases já cobertas ("vestido para casamento") resolvem local com
     confiança alta — chamar IA seria desperdício.

2. **A IA entra onde a heurística confessa fraqueza**: `confidence:
   'media' | 'baixa'`. Frases longas e composicionais ("vestido pra ir num
   casamento de dia na praia sem marcar o braço") são o caso de uso real.

3. **O dicionário vira contexto do prompt.** `synonyms.ts` já estrutura o
   vocabulário da cliente como dados — o prompt do LLM recebe esse mesmo
   vocabulário como referência de facetas válidas. Uma fonte, dois
   consumidores.

4. **Nunca no client.** Chave de API de LLM só em route handler
   (`/api/search/intent`), com rate-limit por sessão e cache por termo
   normalizado (termos repetem MUITO — "vestido preto" é eterno).

## Contrato de resposta (igual ao heurístico)

```jsonc
// POST /api/search/intent  { "term": "roupa pra casamento que esconde barriga" }
{
  "residual": "",
  "facets": {
    "occasion": "casamento",
    "attributes": ["soltinho", "evase", "acinturado", "crepe"]
  },
  "label": "peças que disfarçam a barriga para casamento",
  "confidence": "alta"
}
```

Qualquer resposta que não valide contra o shape de `Intent` é descartada e
a heurística fica valendo — a IA melhora o resultado ou não muda nada,
nunca piora.

## O que NÃO fazer

- Não streamar tokens pro client nem expor o prompt.
- Não deixar o LLM inventar categorias fora do catálogo (validar facets
  contra as facetas reais antes de usar).
- Não bloquear a renderização dos resultados esperando a IA — heurística
  primeiro, refinamento depois.

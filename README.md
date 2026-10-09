# ALS Front – Gestion Ticket

Front-end MVP (kiosque et portail).

Les services back-end (Agent, KMS-Supervision, KMS-Routeur) ne sont pas encore prêts. Le front-end est donc développé à partir d'un **contrat OpenAPI** et d'une **API simulée (MSW)**. Ce travail correspond à la story 3.2.

## Démarrage

Node.js 22.12 ou plus récent.

```bash
npm install
npm run check      # lint du contrat, typecheck, tests
```

## Organisation

| Chemin | Rôle |
|---|---|
| `openapi/openapi.yaml` | **Le contrat** : source unique de vérité |
| `src/api/schema.d.ts` | Types TypeScript **générés** depuis le contrat (ne pas modifier à la main) |
| `src/api/client.ts` | Client HTTP typé (`openapi-fetch`) |
| `src/mocks/fixtures.ts` | Données d'exemple (utilisateurs, comptes, historique, terminaux) |
| `src/mocks/handlers.ts` | Handlers MSW : un par appel du contrat |
| `src/mocks/scenarios.ts` | Interrupteurs de scénario |
| `src/mocks/browser.ts` / `node.ts` | Démarrage du mock dans le navigateur ou dans Node (tests) |
| `public/mockServiceWorker.js` | Script du Service Worker MSW (généré par `msw init`) |
| `tests/contract.test.ts` | Tests de contrat : chaque réponse simulée est validée contre le schéma OpenAPI |
| `tests/scenarios.test.ts` | Comportement du mock, testé avec le client typé |
| `docs/api/DECISIONS.md` | Décisions, questions ouvertes, risques |

## Scripts

| Commande | Effet |
|---|---|
| `npm run api:lint` | Valide le contrat (Redocly) |
| `npm run api:types` | Régénère `src/api/schema.d.ts` après une modification du contrat |
| `npm run api:docs` | Génère la documentation HTML dans `docs/api/index.html` |
| `npm run mock:prism` | Lance un mock Prism sur `http://localhost:4010`, sans le préfixe `/api/v1` (utile pour curl, Postman ou l'équipe back-end) |
| `npm test` | Tests de contrat et de comportement |
| `npm run check` | Les trois vérifications ci-dessus (lint, typecheck, tests) |

## Utiliser l'API dans l'application

```ts
import { createApiClient, newCorrelationId } from "./src/api/client";

const api = createApiClient({ getToken: () => session?.accessToken });

const { data, error } = await api.GET("/accounts/{accountId}/balance", {
  params: { header: { "X-Correlation-Id": newCorrelationId() }, path: { accountId: "ACC-001" } },
});
// data est de type Balance, error est de type Error (du contrat)
```

Démarrer le mock **avant** d'afficher l'application, en développement uniquement :

```ts
if (import.meta.env.DEV) {
  const { startMockWorker } = await import("./src/mocks/browser");
  await startMockWorker();
}
```

## Comptes de démonstration

| Canal | Identifiants | Rôle |
|---|---|---|
| Kiosque | carte `4000000000000001`, PIN `1234` | CUSTOMER (comptes `ACC-001`, `ACC-002`) |
| Portail | `agent` / `agent` | AGENT |
| Portail | `superviseur` / `superviseur` | SUPERVISOR |
| Portail | `admin` / `admin` | ADMIN |

Terminaux disponibles : `KIOSK-01` (ONLINE), `KIOSK-02` (DEGRADED, dépôt indisponible), `KIOSK-03` (OFFLINE).

## Scénarios

| Scénario | Effet |
|---|---|
| `ok` | Tout réussit (valeur par défaut) |
| `cbsDown` | 503 `CBS_UNAVAILABLE`, `retryable: true` |
| `timeout` | 504 `UPSTREAM_TIMEOUT` après 3 s (délai réglable) |
| `refused` | Refus métier : dépôt → 422, PIN faux → 401, terminaux → 403 |
| `unauthorized` | 401 sur tous les appels authentifiés (session expirée) |

Trois façons de changer de scénario :

- **Dans l'URL** : `http://localhost:5173/?mockScenario=cbsDown`. Le scénario est mémorisé jusqu'au prochain changement.
- **Dans la console du navigateur, ou depuis Playwright** :
  ```ts
  window.__mock.setScenario("timeout");
  window.__mock.setTimeoutDelay(500);
  window.__mock.reset();             // restaure soldes et historique
  // Playwright :
  await page.evaluate(() => window.__mock!.setScenario("cbsDown"));
  ```
- **Pour une seule requête** : ajouter l'en-tête `X-Mock-Scenario: refused`.

Dans les tests Vitest : `setScenario("cbsDown")`, importé depuis `src/mocks/scenarios`. Le scénario est réinitialisé après chaque test.

## Modifier le contrat

1. Modifier `openapi/openapi.yaml`.
2. Lancer `npm run api:types`, puis adapter `src/mocks/handlers.ts` et `fixtures.ts`.
3. Si un nouvel appel est ajouté, ajouter son exemple de requête dans `tests/contract.test.ts`. Le test échoue tant qu'un appel du contrat n'est pas simulé.
4. Lancer `npm run check`.

> **Après le gel du lundi 12 octobre**, toute modification du contrat passe par une demande de changement documentée, validée par les responsables concernés (kiosque, portail, back-end). Voir `docs/api/DECISIONS.md`.

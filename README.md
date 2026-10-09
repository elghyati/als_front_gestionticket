# ALS Front – Gestion Ticket

Front-end MVP : kiosque et portail, avec KMS (Kiosk Management System).

Les services back-end (Agent, KMS-Supervision, KMS-Routeur) ne sont pas encore prêts. Le front-end est donc développé à partir d'un **contrat OpenAPI** et d'une **API simulée (MSW)**. Ce travail correspond à la story 3.2.

## Démarrage

Node.js 22.12 ou plus récent.

```bash
npm install
npm run check      # lint du contrat, typecheck, tests
```

## Contenu de l'API

| Domaine | Appels |
|---|---|
| Authentification | `POST /auth/login` (kiosque : carte + PIN ; portail : identifiant + mot de passe) |
| Comptes | Solde, historique paginé |
| Opérations | `POST /deposits`, `POST /withdrawals` : elles appliquent les paramètres du service et vérifient que le service est disponible sur le kiosque |
| **KMS – kiosques** | CRUD `/kms/kiosks`, état de santé calculé, services affectés avec leur disponibilité calculée |
| **KMS – périphériques** | CRUD `/kms/kiosks/{id}/devices`, changement de statut, historique des statuts (par périphérique ou par kiosque) |
| **KMS – paramétrage** | Catalogue global des types de périphériques, services (CRUD), relations service ↔ type de périphérique avec un niveau d'exigence, paramètres des services dépôt et retrait |

Le détail est dans `openapi/openapi.yaml`. On peut aussi générer la documentation HTML avec `npm run api:docs`.

### Disponibilité d'un service sur un kiosque

Un périphérique est **utilisable** quand son statut est `OPERATIONAL` ou `WARNING`. Pour chaque type de périphérique demandé par un service, quand le kiosque n'a aucun périphérique utilisable de ce type :

| Niveau d'exigence | Effet sur le service |
|---|---|
| `MANDATORY` (obligatoire) | `UNAVAILABLE` |
| `RECOMMENDED` (recommandé) | `DEGRADED` : le service fonctionne, avec des fonctions réduites |
| `OPTIONAL` (optionnel) | reste `AVAILABLE`, mais le problème est signalé dans `issues` |

Un service est aussi `UNAVAILABLE` s'il est désactivé globalement, désactivé sur ce kiosque, ou si le kiosque n'est pas `ONLINE`.

L'état de santé du kiosque en découle :
- `OUT_OF_SERVICE` : le kiosque n'est pas `ONLINE`, ou aucun de ses services n'est disponible ;
- `DEGRADED` : un service n'est pas pleinement disponible, ou un périphérique est inutilisable ;
- `HEALTHY` : dans tous les autres cas.

### Rôles

| Opérations | Rôles |
|---|---|
| Lecture KMS : kiosques, périphériques, historique, catalogue, services | AGENT, SUPERVISOR, ADMIN |
| Changement de statut d'un périphérique | SUPERVISOR, ADMIN |
| Création, modification, suppression ; affectations ; exigences ; paramètres | ADMIN |
| Services d'un kiosque, paramètres dépôt et retrait (lecture) | Tout utilisateur connecté (l'application kiosque en a besoin) |

## Organisation

| Chemin | Rôle |
|---|---|
| `openapi/openapi.yaml` | **Le contrat** : source unique de vérité |
| `src/api/schema.d.ts` | Types TypeScript **générés** depuis le contrat (ne pas modifier à la main) |
| `src/api/client.ts` | Client HTTP typé (`openapi-fetch`) |
| `src/mocks/fixtures/` | Données d'exemple : utilisateurs, comptes, kiosques, périphériques, historique, services, paramètres |
| `src/mocks/state.ts` | État en mémoire du mock, modifié par les appels ; `resetMockState()` le réinitialise |
| `src/mocks/kms/availability.ts` | Règles de disponibilité des services et de santé des kiosques |
| `src/mocks/handlers/` | Handlers MSW, un fichier par domaine (`auth`, `accounts`, `transactions`, `kiosks`, `devices`, `settings`) |
| `src/mocks/scenarios.ts` | Interrupteurs de scénario |
| `src/mocks/browser.ts` / `node.ts` | Démarrage du mock dans le navigateur ou dans Node (tests) |
| `public/mockServiceWorker.js` | Script du Service Worker MSW (généré par `msw init`) |
| `tests/contract.test.ts` | Tests de contrat : chaque appel, dans chaque scénario, est validé contre le schéma OpenAPI |
| `tests/banking.test.ts`, `tests/kms.test.ts` | Comportement du mock, testé avec le client typé |
| `docs/api/DECISIONS.md` | Décisions, questions ouvertes, risques |

## Scripts

| Commande | Effet |
|---|---|
| `npm run api:lint` | Valide le contrat (Redocly) |
| `npm run api:types` | Régénère `src/api/schema.d.ts` après une modification du contrat |
| `npm run api:docs` | Génère la documentation HTML dans `docs/api/index.html` |
| `npm run mock:prism` | Lance un mock Prism sur `http://localhost:4010`, sans le préfixe `/api/v1` (utile pour curl, Postman ou l'équipe back-end ; réponses générées, sans état) |
| `npm test` | Tests de contrat et de comportement |
| `npm run check` | Les trois vérifications ci-dessus (lint, typecheck, tests) |

## Utiliser l'API dans l'application

```ts
import { createApiClient, newCorrelationId } from "./src/api/client";

const api = createApiClient({ getToken: () => session?.accessToken });

// Menu du kiosque : services affectés et leur disponibilité
const { data } = await api.GET("/kms/kiosks/{kioskId}/services", {
  params: { header: { "X-Correlation-Id": newCorrelationId() }, path: { kioskId: "KIOSK-01" } },
});
// data.items[n].availability : "AVAILABLE" | "DEGRADED" | "UNAVAILABLE"

// Retrait
const { data: tx, error } = await api.POST("/withdrawals", {
  params: { header: { "X-Correlation-Id": newCorrelationId(), "Idempotency-Key": crypto.randomUUID() } },
  body: { accountId: "ACC-001", kioskId: "KIOSK-01", amount: { amount: 700, currency: "MAD" } },
});
// tx.cashBreakdown : billets à distribuer ; error.code : AMOUNT_NOT_MULTIPLE, INSUFFICIENT_FUNDS, ...
```

Démarrer le mock **avant** d'afficher l'application, en développement uniquement :

```ts
if (import.meta.env.DEV) {
  const { startMockWorker } = await import("./src/mocks/browser");
  await startMockWorker();
}
```

## Données de démonstration

**Comptes**

| Canal | Identifiants | Rôle |
|---|---|---|
| Kiosque | carte `4000000000000001`, PIN `1234` | CUSTOMER (comptes `ACC-001` : 1 520,50 MAD ; `ACC-002` : 80 MAD) |
| Portail | `agent` / `agent` | AGENT |
| Portail | `superviseur` / `superviseur` | SUPERVISOR |
| Portail | `admin` / `admin` | ADMIN |

**Kiosques**

| Kiosque | Statut | Santé | Situation |
|---|---|---|---|
| `KIOSK-01` (Casablanca) | ONLINE | HEALTHY | Tous les périphériques fonctionnent. Services : dépôt, retrait, solde, historique |
| `KIOSK-02` (Rabat) | ONLINE | DEGRADED | Accepteur de billets en ERROR (bourrage) et imprimante en ERROR (plus de papier) : dépôt `UNAVAILABLE`, retrait `DEGRADED`, solde `AVAILABLE` |
| `KIOSK-03` (Marrakech) | OFFLINE | OUT_OF_SERVICE | Périphériques OFFLINE, pas de distributeur. Services : dépôt, solde |

Identifiants des périphériques : `DEV-<kiosque><n°>`, par exemple `DEV-0204` pour l'accepteur de billets de `KIOSK-02`.

**Paramètres**
- Dépôt : 50 à 20 000 MAD par opération, 50 000 MAD par jour, billets de 20, 50, 100 et 200, 200 billets au maximum.
- Retrait : 100 à 5 000 MAD par opération, multiple de 100, 10 000 MAD par jour, billets de 100 et 200, montants rapides 200, 500, 1 000 et 2 000.

## Scénarios

| Scénario | Effet |
|---|---|
| `ok` | Tout réussit (valeur par défaut) |
| `cbsDown` | 503 `CBS_UNAVAILABLE` sur les appels bancaires (connexion, comptes, dépôt, retrait) |
| `kmsDown` | 503 `KMS_UNAVAILABLE` sur les appels `/kms/*` |
| `timeout` | 504 `UPSTREAM_TIMEOUT` après 3 s (délai réglable) |
| `refused` | Refus : dépôt → 422 `DAILY_LIMIT_EXCEEDED`, retrait → 422 `INSUFFICIENT_FUNDS`, PIN faux → 401, appels réservés à un rôle → 403 |
| `unauthorized` | 401 sur tous les appels authentifiés (session expirée) |

Trois façons de changer de scénario :

- **Dans l'URL** : `http://localhost:5173/?mockScenario=kmsDown`. Le scénario est mémorisé jusqu'au prochain changement.
- **Dans la console du navigateur, ou depuis Playwright** :
  ```ts
  window.__mock.setScenario("timeout");
  window.__mock.setTimeoutDelay(500);
  window.__mock.reset();             // restaure toutes les données
  // Playwright :
  await page.evaluate(() => window.__mock!.setScenario("cbsDown"));
  ```
- **Pour une seule requête** : ajouter l'en-tête `X-Mock-Scenario: refused`.

Dans les tests Vitest : `setScenario("cbsDown")`, importé depuis `src/mocks/scenarios`. Le scénario et les données sont réinitialisés après chaque test.

Le mock garde un **état en mémoire**. Un dépôt modifie le solde. Un changement de statut alimente l'historique et modifie la disponibilité des services. Une exigence modifiée change aussitôt la disponibilité sur tous les kiosques.

## Modifier le contrat

1. Modifier `openapi/openapi.yaml`.
2. Lancer `npm run api:types`, puis adapter les handlers (`src/mocks/handlers/`) et les fixtures.
3. Si un nouvel appel est ajouté, ajouter son exemple de requête dans `tests/contract.test.ts`. Le test échoue tant qu'un appel du contrat n'a pas d'exemple, et tant que cet exemple n'est pas valide.
4. Lancer `npm run check`.

> **Après le gel du lundi 12 octobre**, toute modification du contrat passe par une demande de changement documentée, validée par les responsables concernés (kiosque, portail, back-end). Voir `docs/api/DECISIONS.md`.

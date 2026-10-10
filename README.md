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

📘 **Guide fonctionnel des endpoints** (à quoi sert chaque appel, parcours, règles métier, codes d'erreur) : [`docs/api/ENDPOINTS.md`](docs/api/ENDPOINTS.md).
📊 **Schémas des enchaînements** (diagrammes de séquence, logigrammes, modèle de données) : [`docs/api/FLOWS.md`](docs/api/FLOWS.md).

La référence technique est `openapi/openapi.yaml`, consultable dans Swagger (`npm run mock:server`, puis http://localhost:4000/docs) ou en HTML (`npm run api:docs`).

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
| `src/mocks/samples.ts` | Un exemple de requête valide par opération : utilisé par les tests de contrat, Swagger et Postman |
| `src/mocks/http-server.ts`, `src/mocks/swagger/` | Serveur HTTP du mock (`npm run mock:server`) et page Swagger UI |
| `scripts/postman.ts` | Génère la collection Postman à partir du contrat |
| `postman/` | **Collection et environnements Postman générés**, prêts à importer |
| `src/mocks/browser.ts` / `node.ts` | Démarrage du mock dans le navigateur ou dans Node (tests) |
| `public/mockServiceWorker.js` | Script du Service Worker MSW (généré par `msw init`) |
| `tests/contract.test.ts` | Tests de contrat : chaque appel, dans chaque scénario, est validé contre le schéma OpenAPI |
| `tests/banking.test.ts`, `tests/kms.test.ts` | Comportement du mock, testé avec le client typé |
| `tests/postman.test.ts` | Vérifie que la collection Postman est à jour et que chacune de ses requêtes fonctionne |
| `docs/api/ENDPOINTS.md` | **Guide fonctionnel des 38 endpoints** |
| `docs/api/FLOWS.md` | **Schémas des enchaînements** (Mermaid, affichés par GitHub) |
| `docs/api/DECISIONS.md` | Décisions, questions ouvertes, risques |

## Scripts

| Commande | Effet |
|---|---|
| `npm run api:lint` | Valide le contrat (Redocly) |
| `npm run api:types` | Régénère `src/api/schema.d.ts` après une modification du contrat |
| `npm run api:docs` | Génère la documentation HTML dans `docs/api/index.html` |
| `npm run mock:server` | **Lance le mock MSW comme un vrai serveur** sur `http://localhost:4000/api/v1`, avec **Swagger UI** sur `http://localhost:4000/docs` : mêmes données, même logique et mêmes scénarios que les tests (voir ci-dessous) |
| `npm run postman:build` | Régénère la collection Postman (`postman/`) après une modification du contrat ou des exemples |
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

## Swagger UI

```cmd
npm run mock:server
```

Ouvrez ensuite **http://localhost:4000/docs**. Les 38 endpoints y sont classés par domaine, avec leurs schémas et leurs réponses.

Le bouton **Try it out → Execute** appelle directement le mock :
- les paramètres et le corps sont **pré-remplis** avec des exemples valides : il suffit de cliquer sur *Execute* ;
- la barre du haut permet de choisir le **rôle**, qui fournit le token : `ADMIN` par défaut, `CUSTOMER` pour voir un refus 403 sur le KMS ;
- elle permet aussi de choisir le **scénario** (`cbsDown`, `kmsDown`, `timeout`…) et de **réinitialiser les données** ;
- `X-Correlation-Id` et `Idempotency-Key` sont générés automatiquement quand on les laisse vides.

Le contrat brut est aussi disponible sur `http://localhost:4000/openapi.yaml`. Les modifications de `openapi/openapi.yaml` apparaissent après un simple rechargement de la page.

## Collection Postman

Les fichiers sont dans `postman/` :

| Fichier | Contenu |
|---|---|
| `als-api.postman_collection.json` | Les 38 requêtes, classées par dossier (auth, comptes, opérations, kiosques, périphériques, paramétrage), plus un dossier « 0 · Pilotage du mock » |
| `als-mock-server.postman_environment.json` | Environnement pour `npm run mock:server` (`http://localhost:4000/api/v1`) |
| `als-prism.postman_environment.json` | Environnement pour `npm run mock:prism` (`http://localhost:4010`) |

**Importer** : dans Postman, *Import*, puis glissez les trois fichiers. Choisissez ensuite l'environnement **« ALS – Mock MSW (localhost:4000) »** en haut à droite.

Chaque requête est prête à l'emploi :
- le bon token selon le rôle (variables `token_customer`, `token_agent`, `token_supervisor`, `token_admin`) ;
- un `X-Correlation-Id`, et un `Idempotency-Key` pour le dépôt et le retrait, générés par `{{$guid}}` ;
- un corps d'exemple valide ;
- un test qui vérifie le code HTTP attendu ;
- un en-tête `X-Mock-Scenario` désactivé, à cocher pour forcer un scénario sur une seule requête.

**Rejouer toute la collection** (*Run collection*) : elle s'exécute de bout en bout sans erreur. Le dossier 0 se termine par **Réinitialiser**, donc chaque exécution repart des données de démonstration.

Ne modifiez pas ces fichiers à la main : ils sont générés par `npm run postman:build`, et un test vérifie qu'ils sont à jour.

## Serveur mock pour Postman, curl ou une autre application

```cmd
npm run mock:server
```

L'API est servie sous `http://localhost:4000/api/v1`. CORS est ouvert, donc une application lancée sur un autre port peut l'appeler. Pour changer de port : `set PORT=5000 && npm run mock:server`.

Chaque appel doit envoyer deux en-têtes :

| En-tête | Valeur |
|---|---|
| `X-Correlation-Id` | Un UUID, par exemple `3f1c1b0e-0000-4000-8000-000000000001` |
| `Authorization` | `Bearer mock-token-U-CUST-1` (client), `…U-AGENT-1`, `…U-SUP-1` ou `…U-ADMIN-1`. On peut aussi utiliser le `accessToken` renvoyé par `POST /auth/login` |

Le dépôt et le retrait demandent aussi l'en-tête `Idempotency-Key: <uuid>`.

Exemple (Windows `cmd`) :
```cmd
curl -H "Authorization: Bearer mock-token-U-AGENT-1" -H "X-Correlation-Id: 3f1c1b0e-0000-4000-8000-000000000001" http://localhost:4000/api/v1/kms/kiosks
```

Pilotage du mock (sans authentification) :

| Appel | Effet |
|---|---|
| `GET http://localhost:4000/__mock` | Scénario courant et liste des scénarios |
| `POST http://localhost:4000/__mock/scenario` avec `{"scenario":"cbsDown"}` (et `"timeoutDelayMs": 500` en option) | Change de scénario |
| `POST http://localhost:4000/__mock/reset` | Restaure les données de démonstration et le scénario `ok` |

L'état est conservé tant que le serveur tourne : un dépôt modifie le solde, un changement de statut alimente l'historique, etc.

## Modifier le contrat

1. Modifier `openapi/openapi.yaml`.
2. Lancer `npm run api:types`, puis adapter les handlers (`src/mocks/handlers/`) et les fixtures.
3. Si un nouvel appel est ajouté, ajouter son exemple de requête dans `src/mocks/samples.ts`. Les tests échouent tant qu'un appel du contrat n'a pas d'exemple, et tant que cet exemple n'est pas valide. Cet exemple sert aussi à Swagger et à Postman.
4. Lancer `npm run postman:build` pour régénérer la collection Postman.
5. Lancer `npm run check`.

> **Après le gel du lundi 12 octobre**, toute modification du contrat passe par une demande de changement documentée, validée par les responsables concernés (kiosque, portail, back-end). Voir `docs/api/DECISIONS.md`.
